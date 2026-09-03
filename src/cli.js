#!/usr/bin/env node
/**
 * Entry point. Default mode starts the GUI server; `extract` runs headless for
 * scripts, cron and CI.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { startServer } from './server.js';
import { extractFeeds } from './extract.js';
import { toCsv, toJson, toMarkdown } from './export.js';
import { LIMITS } from './feed.js';
import { parseOpml, looksLikeOpml } from './opml.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));

const HELP = `
rss-feed-extractor ${PKG.version} — free, local, zero-dependency feed extraction

USAGE
  node src/cli.js [serve] [options]        start the GUI and open a browser
  node src/cli.js extract <url...> [opts]  headless extraction to stdout/file

SERVE OPTIONS
  --port <n>        port to listen on (default 5055, auto-increments if busy)
  --host <addr>     bind address (default 127.0.0.1 — keep it local)
  --no-open         do not launch a browser
  --quiet           minimal console output

EXTRACT OPTIONS
  --max <n>         items per feed, ${LIMITS.minItemsPerFeed}-${LIMITS.maxItemsPerFeed} (default ${LIMITS.defaultItemsPerFeed})
  --no-content      omit full article content (keeps summary + snippet)
  --dedupe          drop repeated items across a feed
  --timeout <ms>    per-feed timeout (default 20000)
  --concurrency <n> feeds fetched at once, 1-20 (default 5)
  --allow-private   permit private/loopback feed URLs
  --out <file>      write to a file instead of stdout
  --format <fmt>    json (default) | csv | md | ndjson
  --errors          also print per-feed error records to stderr

EXAMPLES
  node src/cli.js
  node src/cli.js extract https://feeds.bbci.co.uk/news/rss.xml --max 10
  node src/cli.js extract feeds.txt --format csv --out news.csv
  node src/cli.js extract subscriptions.opml --max 5

Inputs may be URLs, a plain text file of URLs (one per line, # to comment), or
an OPML outline file, which is expanded to its feed URLs automatically.
`.trimStart();

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      i += 1;
    }
  }
  return { flags, positional };
}

function openBrowser(url) {
  const commands = {
    win32: ['cmd', ['/c', 'start', '', url]],
    darwin: ['open', [url]],
  };
  const [bin, args] = commands[process.platform] ?? ['xdg-open', [url]];
  try {
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* the URL is printed anyway, so this is not fatal */
  }
}

/**
 * Turns positional arguments into a URL list. Accepts bare URLs, `@file` and
 * plain paths. A file that sniffs as OPML is expanded to its feed URLs instead
 * of being read line-by-line, so `extract mysubs.opml` does the obvious thing.
 */
function collectUrls(positional) {
  const urls = [];
  for (const entry of positional) {
    const pathish = entry.startsWith('@') ? entry.slice(1) : entry;
    if (!fs.existsSync(pathish) || !fs.statSync(pathish).isFile()) {
      if (entry.startsWith('@')) {
        process.stderr.write(`error: cannot read @${pathish}\n`);
        continue;
      }
      urls.push(entry);
      continue;
    }
    const text = fs.readFileSync(pathish, 'utf8');
    if (looksLikeOpml(text) || /\.opml$/i.test(pathish)) {
      const { feeds, warnings } = parseOpml(text);
      for (const warning of warnings) process.stderr.write(`opml: ${warning}\n`);
      process.stderr.write(`opml: ${feeds.length} feed(s) read from ${pathish}\n`);
      urls.push(...feeds.map((f) => f.url));
    } else {
      urls.push(...text.split(/\r?\n/));
    }
  }
  return urls.filter((u) => u && u.trim() && !u.trim().startsWith('#'));
}

async function runExtract(flags, positional) {
  const feedUrls = collectUrls(positional);
  if (!feedUrls.length) {
    process.stderr.write('error: no feed URLs given (pass them as arguments or use @file)\n');
    process.exitCode = 2;
    return;
  }

  const result = await extractFeeds({
    feedUrls,
    maxItemsPerFeed: flags.max ?? LIMITS.defaultItemsPerFeed,
    includeContent: !flags['no-content'],
    removeDuplicates: Boolean(flags.dedupe),
    timeoutMs: flags.timeout ?? 20_000,
    concurrency: flags.concurrency ?? 5,
    allowPrivate: Boolean(flags['allow-private']),
  });

  const format = String(flags.format ?? 'json').toLowerCase();
  let payload;
  if (format === 'csv') payload = toCsv(result.items);
  else if (format === 'md' || format === 'markdown') payload = toMarkdown(result.items);
  else if (format === 'ndjson') payload = result.items.map((i) => JSON.stringify(i)).join('\n');
  else payload = toJson({ items: result.items, errors: result.errors, feeds: result.feeds, stats: result.stats });

  const outFile = typeof flags.out === 'string' ? path.resolve(flags.out) : null;
  if (outFile) {
    fs.writeFileSync(outFile, payload.endsWith('\n') ? payload : `${payload}\n`, 'utf8');
    if (!flags.quiet) {
      process.stderr.write(`wrote ${result.items.length} items to ${path.relative(process.cwd(), outFile) || outFile}\n`);
    }
  } else {
    process.stdout.write(`${payload}\n`);
  }

  if (flags.errors && result.errors.length) {
    for (const err of result.errors) process.stderr.write(`error: ${err.feedUrl} — ${err.error}\n`);
  }
  if (result.errors.length && !result.items.length) process.exitCode = 1;
}

function runServe(flags) {
  const port = Number.parseInt(flags.port, 10) || 5055;
  const host = typeof flags.host === 'string' ? flags.host : '127.0.0.1';

  startServer({ port, host }).then(({ server, port: bound }) => {
    const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${bound}/`;
    if (!flags.quiet) {
      process.stdout.write(`\n  rss-feed-extractor ${PKG.version}\n  GUI   ${url}\n  stop  Ctrl+C\n\n`);
    }
    if (!flags['no-open']) openBrowser(url);

    const shutdown = () => {
      process.stdout.write('\n  shutting down…\n');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`error: every port from ${port} to ${port + 20} is busy\n`);
    } else if (err.code === 'EACCES') {
      process.stderr.write(`error: cannot bind ${host}:${port} (permission denied)\n`);
    } else {
      process.stderr.write(`error: ${err.message}\n`);
    }
    process.exitCode = 1;
  });
}

const { flags, positional } = parseArgs(process.argv.slice(2));

if (flags.help || flags.h) {
  process.stdout.write(HELP);
} else if (flags.version || flags.v) {
  process.stdout.write(`${PKG.version}\n`);
} else if (positional[0] === 'extract') {
  runExtract(flags, positional.slice(1)).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
} else if (positional[0] === 'serve') {
  runServe(flags);
} else if (positional.length && !flags.port) {
  // `cli.js <url...>` is a shorthand for headless extraction.
  runExtract(flags, positional).catch((err) => {
    process.stderr.write(`error: ${err.message}\n`);
    process.exitCode = 1;
  });
} else {
  runServe(flags);
}
