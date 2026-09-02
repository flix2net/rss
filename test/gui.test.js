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
  const external = [...html.matchAll(/(?:src|href)\s*=\s*"(https?:)?\/\/[^"]+"/gi)].map((m) => m[0]);
  assert.deepEqual(external, [], `GUI must stay offline-capable: ${external.join(', ')}`);
});
