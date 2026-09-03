import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';

import { startServer } from '../src/server.js';
import { extractFeeds } from '../src/extract.js';
import { fetchFeed, isPrivateHost, normalizeFeedUrl, mapLimit } from '../src/fetcher.js';
import { BROWSER_MODULES } from '../src/browser-modules.js';

const FEED = (n) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Fixture</title><link>http://127.0.0.1/f</link>
${Array.from({ length: n }, (_, i) => `<item><title>Item ${i + 1}</title><link>http://127.0.0.1/${i + 1}</link><guid>f-${i + 1}</guid></item>`).join('')}
</channel></rss>`;

// "Café résumé" encoded as windows-1252, which plenty of legacy feeds still do.
const LATIN = Buffer.from(
  '<?xml version="1.0" encoding="ISO-8859-1"?>\n<rss><channel><title>Legacy</title>'
  + '<item><title>Caf\xe9 r\xe9sum\xe9</title><link>http://127.0.0.1/cafe</link></item>'
  + '</channel></rss>', 'binary',
);

let fixture;
let fixtureUrl;
let app;
let appUrl;

before(async () => {
  fixture = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (path === '/feed.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml; charset=UTF-8' });
      return res.end(FEED(7));
    }
    if (path === '/latin.xml') {
      res.writeHead(200, { 'content-type': 'text/xml' });
      return res.end(LATIN);
    }
    if (path === '/gzip.xml') {
      res.writeHead(200, { 'content-type': 'application/rss+xml', 'content-encoding': 'gzip' });
      return res.end(gzipSync(Buffer.from(FEED(3))));
    }
    if (path === '/missing') return res.writeHead(404).end('nope');
    if (path === '/empty') return res.writeHead(200, { 'content-type': 'text/xml' }).end('');
    if (path === '/html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<html><body>human page</body></html>');
    if (path === '/slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/rss+xml' }); res.end(FEED(1)); }, 3000);
      return undefined;
    }
    return res.writeHead(404).end();
  });

  await new Promise((resolve) => fixture.listen(0, '127.0.0.1', resolve));
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}`;

  const started = await startServer({ port: 0, host: '127.0.0.1' });
  app = started.server;
  appUrl = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => fixture.close(resolve));
  await new Promise((resolve) => app.close(resolve));
});

/* ---------------------------------------------------------------- fetcher */

test('isPrivateHost recognises loopback, RFC1918, CGNAT and link-local', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.16.0.1', '169.254.1.1', '::1', '[::1]', '100.64.0.1', 'foo.internal']) {
    assert.equal(isPrivateHost(host), true, `${host} should be private`);
  }
  for (const host of ['example.com', '93.184.216.34', '172.32.0.1', '8.8.8.8']) {
    assert.equal(isPrivateHost(host), false, `${host} should be public`);
  }
});

test('normalizeFeedUrl adds https and rejects non-http protocols', () => {
  assert.equal(normalizeFeedUrl('example.com/feed').href, 'https://example.com/feed');
  assert.equal(normalizeFeedUrl('http://example.com/f').protocol, 'http:');
  assert.throws(() => normalizeFeedUrl('ftp://example.com/f'), /Unsupported protocol/);
  assert.throws(() => normalizeFeedUrl(''), /Empty URL/);
});

test('fetchFeed refuses private hosts unless allowPrivate is set', async () => {
  await assert.rejects(() => fetchFeed(`${fixtureUrl}/feed.xml`), /private\/internal host/);
  const ok = await fetchFeed(`${fixtureUrl}/feed.xml`, { allowPrivate: true });
  assert.equal(ok.status, 200);
  assert.match(ok.text, /<rss/);
});

test('fetchFeed decodes windows-1252 declared in the XML prolog', async () => {
  const res = await fetchFeed(`${fixtureUrl}/latin.xml`, { allowPrivate: true });
  assert.equal(res.encoding, 'iso-8859-1');
  assert.ok(res.text.includes('Café résumé'), 'accented text should survive decoding');
});

test('fetchFeed transparently handles gzip', async () => {
  const res = await fetchFeed(`${fixtureUrl}/gzip.xml`, { allowPrivate: true });
  assert.match(res.text, /Item 1/);
});

test('fetchFeed surfaces HTTP status, empty bodies and timeouts', async () => {
  await assert.rejects(() => fetchFeed(`${fixtureUrl}/missing`, { allowPrivate: true }), /HTTP 404/);
  await assert.rejects(() => fetchFeed(`${fixtureUrl}/empty`, { allowPrivate: true }), /empty body/);
  await assert.rejects(
    () => fetchFeed(`${fixtureUrl}/slow`, { allowPrivate: true, timeoutMs: 1200 }),
    /Timed out/,
  );
});

test('mapLimit respects the ceiling and preserves order', async () => {
  let live = 0;
  let peak = 0;
  const out = await mapLimit(Array.from({ length: 12 }, (_, i) => i), 3, async (i) => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5 + (i % 4) * 4));
    live -= 1;
    return i * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(out, Array.from({ length: 12 }, (_, i) => i * 2));
});

/* --------------------------------------------------------------- extract */

test('extractFeeds returns items plus per-feed error records', async () => {
  const result = await extractFeeds({
    feedUrls: [`${fixtureUrl}/feed.xml`, `${fixtureUrl}/missing`],
    allowPrivate: true,
    maxItemsPerFeed: 5,
  });
  assert.equal(result.stats.requested, 2);
  assert.equal(result.stats.succeeded, 1);
  assert.equal(result.stats.failed, 1);
  assert.equal(result.items.length, 5, 'should honour maxItemsPerFeed');
  assert.equal(result.items[0].feedTitle, 'Fixture');
  assert.deepEqual(result.items.map((i) => i.index), [1, 2, 3, 4, 5]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].type, 'error');
  assert.equal(result.errors[0].status, 404);
  assert.equal(result.feeds.find((f) => !f.ok).code, 'http_status');
});

test('extractFeeds de-duplicates and normalises the URL list', async () => {
  const result = await extractFeeds({
    feedUrls: [`${fixtureUrl}/feed.xml`, `${fixtureUrl}/feed.xml`, `${fixtureUrl}/feed.xml/`],
    allowPrivate: true,
    maxItemsPerFeed: 100,
  });
  assert.equal(result.stats.requested, 2, 'trailing slash is a different feed, exact dupes are not');
});

test('extractFeeds rejects unusable input before touching the network', async () => {
  await assert.rejects(() => extractFeeds({ feedUrls: [] }), /at least one feed URL/);
  await assert.rejects(() => extractFeeds({ feedUrls: ['not a url at all!!'] }), /Invalid feed URL/);
});

test('a non-feed HTML page is reported as a parse error, not a crash', async () => {
  const result = await extractFeeds({ feedUrls: `${fixtureUrl}/html`, allowPrivate: true });
  assert.equal(result.items.length, 0);
  assert.match(result.errors[0].error, /Unrecognised document root/);
  assert.equal(result.errors[0].code, 'parse_failed');
});

/* ---------------------------------------------------------------- server */

test('GET /api/health advertises limits', async () => {
  const res = await fetch(`${appUrl}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.limits.maxItemsPerFeed, 500);
});

test('POST /api/extract requires the custom header (CSRF guard)', async () => {
  const res = await fetch(`${appUrl}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ feedUrls: [`${fixtureUrl}/feed.xml`], allowPrivate: true }),
  });
  assert.equal(res.status, 403);
});

test('POST /api/extract serves results to the GUI', async () => {
  const res = await fetch(`${appUrl}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rss-extractor': '1' },
    body: JSON.stringify({ feedUrls: [`${fixtureUrl}/feed.xml`], allowPrivate: true, maxItemsPerFeed: 3 }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.items.length, 3);
  assert.equal(body.stats.succeeded, 1);
});

test('GET /api/extract is rejected with 405', async () => {
  assert.equal((await fetch(`${appUrl}/api/extract`)).status, 405);
});

test('the GUI is served and path traversal is blocked', async () => {
  const page = await fetch(`${appUrl}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /RSS Feed Extractor/);

  for (const attack of ['/../package.json', '/..%2fpackage.json', '/%2e%2e/package.json', '/..\\..\\package.json']) {
    const res = await fetch(`${appUrl}${attack}`);
    assert.ok(res.status === 404 || res.status === 400, `${attack} returned ${res.status}`);
    assert.ok(!(await res.text()).includes('"dependencies"'), `${attack} leaked package.json`);
  }
});

test('the /lib route serves exactly the allowlisted browser modules', async () => {
  for (const name of BROWSER_MODULES) {
    const res = await fetch(`${appUrl}/lib/${name}`);
    assert.equal(res.status, 200, `/lib/${name} should be served`);
    // A wrong MIME type makes the browser refuse the ES module import.
    assert.match(res.headers.get('content-type'), /javascript/, `${name} MIME`);
    const body = await res.text();
    assert.equal(/node:/.test(body), false, `/lib/${name} must be browser-safe`);
  }

  const feed = await fetch(`${appUrl}/lib/feed.js`);
  assert.match(await feed.text(), /export function parseFeed/);
});

test('/lib cannot be used to read the source tree', async () => {
  for (const probe of ['/lib/server.js', '/lib/cli.js', '/lib/package.json', '/lib/browser-modules.js']) {
    const res = await fetch(`${appUrl}${probe}`);
    assert.equal(res.status, 404, `${probe} should not be served`);
  }

  // Encoded traversal survives URL() normalisation and must still miss the allowlist.
  for (const probe of ['/lib/%2e%2e/package.json', '/lib/..%2fserver.js', '/lib/../package.json']) {
    const res = await fetch(`${appUrl}${probe}`);
    assert.ok(res.status === 404 || res.status === 400, `${probe} returned ${res.status}`);
    assert.ok(!(await res.text()).includes('"dependencies"'), `${probe} leaked package.json`);
  }
});

test('invalid JSON bodies get a 400 rather than a stack trace', async () => {
  const res = await fetch(`${appUrl}/api/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rss-extractor': '1' },
    body: '{oops',
  });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /not valid JSON/);
});
