/*
 * Assembles the GitHub Pages artifact.
 *
 * Pages serves static files, so the hosted app needs the parser modules next to
 * it. Rather than duplicate them in the repo (which would drift), this copies
 * the real src/ files into the build output at deploy time. One source of truth.
 *
 * Run directly:  node tools/build-site.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');

/** Files the hosted GUI imports at runtime, in dependency order. */
const PARSER_FILES = ['xml.js', 'feed.js'];

function rel(...parts) {
  return path.join(ROOT, ...parts);
}

function reset() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(path.join(OUT, 'app', 'lib'), { recursive: true });
}

function copy(from, to) {
  fs.copyFileSync(rel(from), path.join(OUT, to));
  return fs.statSync(path.join(OUT, to)).size;
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

function copyDocs() {
  const docsDir = rel('docs');
  let count = 0;
  for (const entry of fs.readdirSync(docsDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    copy(path.join('docs', entry.name), entry.name);
    count += 1;
  }
  return count;
}

export function build() {
  reset();
  const docs = copyDocs();
  const gui = copy(path.join('public', 'index.html'), path.join('app', 'index.html'));
  const lib = PARSER_FILES.map((file) => {
    assertBrowserSafe(file);
    return { file, bytes: copy(path.join('src', file), path.join('app', 'lib', file)) };
  });

  return { out: OUT, docs, gui, lib };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = build();
  const total = result.lib.reduce((sum, m) => sum + m.bytes, 0) + result.gui;
  process.stdout.write(
    `site/ built: ${result.docs} docs files, app/index.html (${result.gui} B), `
    + `lib [${result.lib.map((m) => `${m.file} ${Math.round(m.bytes / 1024)} KB`).join(', ')}]\n`
    + `app payload ≈ ${Math.round(total / 1024)} KB, zero dependencies\n`,
  );
}
