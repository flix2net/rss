/*
 * Assembles the hosted web app under docs/app/ so GitHub Pages serves it from
 * the existing branch deploy — no Actions workflow, and therefore no extra
 * token scope needed to publish.
 *
 * Pages serves static files only, and no real feed sends
 * Access-Control-Allow-Origin, so the hosted GUI fetches through the user's own
 * relay (worker/relay.js) and parses in the tab. The parser is not duplicated by
 * hand: it is copied from src/ here, and test/site.test.js asserts the committed
 * copy is byte-identical, so it cannot silently drift from the CLI's.
 *
 * Run after changing anything in src/ or public/:  node tools/build-site.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'app');

/** Files the hosted GUI imports at runtime, in dependency order. */
const PARSER_FILES = ['xml.js', 'feed.js'];

function rel(...parts) {
  return path.join(ROOT, ...parts);
}

/**
 * The parser is shared with the browser, so a Node-only dependency added later
 * would break the hosted build silently. Fail the build loudly instead.
 */
function assertBrowserSafe(file) {
  const source = fs.readFileSync(rel('src', file), 'utf8');
  const offenders = [...source.matchAll(/\b(?:from\s+|require\()["']node:([^"']+)["']/g)].map((m) => m[1]);
  for (const global of ['Buffer', 'process.', '__dirname', 'require(']) {
    if (source.includes(global)) offenders.push(global.trimEnd());
  }
  if (offenders.length) {
    throw new Error(`src/${file} is not browser-safe (uses: ${offenders.join(', ')}). `
      + 'The hosted app imports this file directly.');
  }
}

export function build() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'lib'), { recursive: true });

  const gui = { from: 'public/index.html', to: 'app/index.html' };
  fs.copyFileSync(rel(gui.from), path.join(OUT, 'index.html'));

  const lib = PARSER_FILES.map((file) => {
    assertBrowserSafe(file);
    fs.copyFileSync(rel('src', file), path.join(OUT, 'lib', file));
    return { file, bytes: fs.statSync(path.join(OUT, 'lib', file)).size };
  });

  return { out: OUT, gui: gui.from, guiBytes: fs.statSync(path.join(OUT, 'index.html')).size, lib };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = build();
  const total = result.lib.reduce((sum, m) => sum + m.bytes, 0) + result.guiBytes;
  process.stdout.write(
    `docs/app/ built from ${result.gui}: `
    + `lib [${result.lib.map((m) => `${m.file} ${Math.round(m.bytes / 1024)} KB`).join(', ')}]\n`
    + `app payload ≈ ${Math.round(total / 1024)} KB, zero dependencies, served at /rss/app/\n`,
  );
}
