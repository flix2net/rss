import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { isPrivateHost as localIsPrivateHost } from '../src/fetcher.js';
import worker, { isPrivateHost as relayIsPrivateHost } from '../worker/relay.js';

const relayFetch = (url, init) => worker.fetch(new Request(url, init));

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Stubs the upstream call and records what the relay actually requested. */
function stubUpstream({ status = 200, body = '<rss/>', contentType = 'application/rss+xml', finalUrl, headers = {} } = {}) {
  const calls = [];
  globalThis.fetch = async (href, init) => {
    calls.push({ href, init });
    const res = new Response(body, {
      status,
      headers: { 'content-type': contentType, ...headers },
    });
    // undici's Response constructor ignores `url`, so the post-redirect URL has
    // to be forced on — which is what a real Worker runtime reports.
    if (finalUrl !== undefined) Object.defineProperty(res, 'url', { value: finalUrl });
    return res;
  };
  return calls;
}

const feed = (n) => encodeURIComponent(`https://example.com/${n}.xml`);

test('relay SSRF guard is never looser than the local server guard', () => {
  const cases = [
    'localhost', 'LOCALHOST', 'api.localhost', 'metadata.google.internal', 'corp.internal',
    '127.0.0.1', '127.1.2.3', '10.0.0.5', '10.255.255.255', '192.168.0.1', '172.16.0.1',
    '172.31.255.255', '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1',
    '::1', 'fe80::1', 'fc00::1', 'fd12:3456::78', '[::1]',
  ];
  for (const host of cases) {
    assert.equal(relayIsPrivateHost(host), true, `relay must block ${host}`);
    assert.equal(localIsPrivateHost(host), true, `local server blocks ${host} too — the two must agree`);
  }
});

test('relay allows the same public hosts the local server allows', () => {
  for (const host of ['example.com', 'feeds.bbci.co.uk', '172.32.0.1', '172.15.0.1', '8.8.8.8']) {
    assert.equal(relayIsPrivateHost(host), false, `relay should fetch ${host}`);
    assert.equal(localIsPrivateHost(host), false, `parity for ${host}`);
  }
});

test('OPTIONS preflight is answered with CORS headers', async () => {
  const res = await relayFetch(`https://relay.test/?url=${feed('a')}`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
});

test('non-GET is rejected', async () => {
  const res = await relayFetch(`https://relay.test/?url=${feed('a')}`, { method: 'POST' });
  assert.equal(res.status, 405);
});

test('missing url parameter is rejected', async () => {
  const res = await relayFetch('https://relay.test/');
  assert.equal(res.status, 400);
});

test('private targets are refused before any upstream request', async () => {
  const calls = stubUpstream({ body: 'SECRET' });
  const res = await relayFetch(`https://relay.test/?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data/')}`);
  assert.equal(res.status, 403);
  assert.equal(calls.length, 0, 'the relay must not contact the host at all');
});

test('non-http protocols are refused', async () => {
  stubUpstream();
  for (const target of ['ftp://example.com/feed.xml', 'file:///etc/passwd', 'javascript:alert(1)']) {
    const res = await relayFetch(`https://relay.test/?url=${encodeURIComponent(target)}`);
    assert.equal(res.status, 400, `${target} should be rejected`);
  }
});

test('a bare hostname is upgraded to https like the CLI does', async () => {
  const calls = stubUpstream();
  const res = await relayFetch(`https://relay.test/?url=${encodeURIComponent('example.com/feed.xml')}`);
  assert.equal(res.status, 200);
  assert.equal(calls[0].href, 'https://example.com/feed.xml');
});

test('happy path relays bytes, content-type and final URL', async () => {
  stubUpstream({ body: '<rss>hello</rss>', finalUrl: 'https://example.com/real.xml' });
  const res = await relayFetch(`https://relay.test/?url=${feed('ok')}`, {
    headers: { origin: 'https://flix2net.github.io' },
  });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<rss>hello</rss>');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://flix2net.github.io');
  assert.equal(res.headers.get('x-relay-final-url'), 'https://example.com/real.xml');
  assert.match(res.headers.get('access-control-expose-headers'), /x-relay-final-url/);
});

test('a runtime that leaves Response.url empty falls back to the requested URL', async () => {
  stubUpstream({ body: '<rss/>' });
  const res = await relayFetch(`https://relay.test/?url=${feed('nourl')}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-relay-final-url'), 'https://example.com/nourl.xml');
});

test('upstream failure surfaces as 502, not as an empty success', async () => {
  stubUpstream({ status: 404, body: 'not found' });
  const res = await relayFetch(`https://relay.test/?url=${feed('gone')}`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /404/);
});

test('oversized feeds are refused on declared length', async () => {
  stubUpstream({ body: 'x', headers: { 'content-length': String(9 * 1024 * 1024) } });
  const res = await relayFetch(`https://relay.test/?url=${feed('big')}`);
  assert.equal(res.status, 413);
});

test('unreachable upstream becomes 502 rather than a 500 crash', async () => {
  globalThis.fetch = async () => { throw new Error('socket hang up'); };
  const res = await relayFetch(`https://relay.test/?url=${feed('down')}`);
  assert.equal(res.status, 502);
});
