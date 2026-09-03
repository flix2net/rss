import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

test('the GUI script parses as valid JavaScript', () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 1, 'expected an inline <script> block');
  for (const [, code] of blocks) {
    assert.doesNotThrow(() => new vm.Script(code, { filename: 'index.html' }));
  }
});

test('every id referenced by $() exists exactly once', () => {
  const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map((m) => m[1]);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids would break getElementById: ${dupes.join(', ')}`);

  const referenced = [...html.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(referenced)].filter((id) => !ids.includes(id));
  assert.deepEqual(missing, [], `referenced but not in markup: ${missing.join(', ')}`);
});

test('the GUI sends the CSRF header the API requires', () => {
  // Without this the app would 403 against its own server.
  assert.match(html, /'x-rss-extractor'\s*:\s*'1'/);
});

test('feed content is never injected as HTML', () => {
  // Everything rendered from feed data must go through textContent, not innerHTML.
  assert.equal(/\.innerHTML\s*=/.test(html), false, 'innerHTML assignment found');
  assert.equal(/document\.write/.test(html), false);
  assert.match(html, /Content-Security-Policy/);
});

test('no remote scripts, fonts or CDNs are referenced', () => {
  // The invariant is "nothing the browser auto-fetches", which is narrower than
  // "no absolute URLs": an <a href> to the source repo is never requested, so it
  // does not cost offline-capability. Subresources do.
  const subresources = [
    ...html.matchAll(/\bsrc\s*=\s*"(?:https?:)?\/\/[^"]*"/gi),
    ...html.matchAll(/<link[^>]+href\s*=\s*"(?:https?:)?\/\/[^"]*"/gi),
    ...html.matchAll(/@import\s+["']?(?:https?:)?\/\//gi),
    ...html.matchAll(/url\(\s*["']?(?:https?:)?\/\//gi),
  ].map((m) => m[0]);
  assert.deepEqual(subresources, [], `GUI must stay offline-capable: ${subresources.join(', ')}`);

  // Guard the two ways code could reach the network from a script tag.
  assert.equal(/import\(\s*["']https?:/.test(html), false, 'remote dynamic import found');
  assert.equal(/<script[^>]+\bsrc\s*=/.test(html), false, 'external script tag found');
});

test('CSP allows same-origin, a workers.dev relay and the demo endpoint, nothing else', () => {
  const connectSrc = html.match(/connect-src\s+([^;"]+)/)?.[1]?.trim();
  assert.ok(connectSrc, 'connect-src must be declared');
  assert.deepEqual(connectSrc.split(/\s+/).sort(),
    ["'self'", 'https://*.workers.dev', 'https://api.rss2json.com']);

  // The hosted build loads the parser via a same-origin dynamic import, which
  // needs 'self' in script-src; dropping it would break the Pages deployment.
  const scriptSrc = html.match(/script-src\s+([^;"]+)/)?.[1]?.trim();
  assert.match(scriptSrc, /(^|\s)'self'(\s|$)/, "script-src must include 'self'");
});
