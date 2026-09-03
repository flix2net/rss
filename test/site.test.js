import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from '../tools/build-site.js';
import { BROWSER_MODULES } from '../src/browser-modules.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const APP = path.join(ROOT, 'docs', 'app');

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Deployed</title><link>https://example.com</link>
<item><title>First item</title><link>https://example.com/1</link><guid>d-1</guid>
<pubDate>Mon, 01 Sep 2025 09:00:00 GMT</pubDate>
<description><![CDATA[Body of the <b>first</b> item.]]></description></item>
<item><title>Second item</title><link>https://example.com/2</link><guid>d-2</guid></item>
</channel></rss>`;

let appHtml;

before(() => {
  build();
  appHtml = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
});

const SHIPPED = BROWSER_MODULES;

test('the committed app exists where Pages will serve it', () => {
  assert.ok(fs.existsSync(path.join(APP, 'index.html')));
  for (const file of SHIPPED) {
    assert.ok(fs.existsSync(path.join(APP, 'lib', file)), `docs/app/lib/${file} missing`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, 'docs', '.nojekyll')),
    '.nojekyll missing — Jekyll would mangle the app');
});

test('the copied modules are byte-identical to src, so they cannot drift', () => {
  for (const file of SHIPPED) {
    const shipped = fs.readFileSync(path.join(APP, 'lib', file));
    const source = fs.readFileSync(path.join(ROOT, 'src', file));
    assert.equal(shipped.equals(source), true,
      `docs/app/lib/${file} is stale — run "node tools/build-site.js" and commit`);
  }
});

test('the app references its modules at the paths they will actually be served from', () => {
  // Pages serves the app at /rss/app/, so a wrong relative specifier is a 404 at runtime.
  assert.match(appHtml, /import\(['"]\.\/lib\/feed\.js['"]\)/);
  assert.match(appHtml, /import\(['"]\.\/lib\/hosted\.js['"]\)/);
  assert.equal(appHtml.includes("from 'node:"), false);
});

test('the hosted UI is present and wired', () => {
  assert.match(appHtml, /id="relayPanel"/);
  assert.match(appHtml, /id="relayUrl"/);
  assert.match(appHtml, /id="demoNotice"/);
  assert.match(appHtml, /detectMode/);
  assert.match(appHtml, /extractViaRss2Json/);
});

test('CSP permits the same-origin parser and both transports, nothing more', () => {
  const connectSrc = appHtml.match(/connect-src\s+([^;"]+)/)?.[1]?.trim();
  assert.deepEqual(connectSrc?.split(/\s+/).sort(),
    ["'self'", 'https://*.workers.dev', 'https://api.rss2json.com']);

  const scriptSrc = appHtml.match(/script-src\s+([^;"]+)/)?.[1]?.trim();
  assert.match(scriptSrc, /(^|\s)'self'(\s|$)/, "script-src needs 'self' for the parser import");
});

test('copied modules are browser-safe', () => {
  for (const file of SHIPPED) {
    const source = fs.readFileSync(path.join(APP, 'lib', file), 'utf8');
    assert.equal(/node:/.test(source), false, `${file} would not load in a browser`);
    assert.equal(/\bBuffer\b|\bprocess\./.test(source), false, `${file} uses Node globals`);
  }
});

test('the parser works when imported from its deployed location', async () => {
  const { parseFeed } = await import(pathToFileURL(path.join(APP, 'lib', 'feed.js')).href);
  const result = parseFeed(FIXTURE, 'https://example.com/feed.xml', { maxItemsPerFeed: 50 });

  assert.equal(result.items.length, 2);
  assert.equal(result.feed.title, 'Deployed');

  const [first] = result.items;
  assert.equal(first.title, 'First item');
  assert.equal(first.link, 'https://example.com/1');
  // Documented contract: content keeps markup, contentText/summary strip it.
  assert.equal(first.content, 'Body of the <b>first</b> item.');
  assert.equal(first.contentText, 'Body of the first item.');
  assert.equal(first.summary, 'Body of the first item.');
  assert.ok(first.pubDate, 'pubDate should be parsed to a timestamp');
  assert.equal(result.items[1].contentText, null, 'absent fields are null, not undefined');
});

test('build is idempotent and leaves no stale files', () => {
  const marker = path.join(APP, 'lib', 'stale-should-not-survive.js');
  fs.writeFileSync(marker, 'export const gone = true;');
  build();
  assert.equal(fs.existsSync(marker), false, 'a previous build artifact survived the rebuild');
});
