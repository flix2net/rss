/**
 * Orchestrates a batch of feeds: normalises input, fetches with bounded
 * concurrency, parses, and returns flat results plus per-feed errors.
 */

import { fetchFeed, mapLimit, normalizeFeedUrl, FetchError } from './fetcher.js';
import { parseFeed, LIMITS } from './feed.js';

export const DEFAULTS = {
  maxItemsPerFeed: LIMITS.defaultItemsPerFeed,
  includeContent: true,
  removeDuplicates: false,
  concurrency: 5,
  timeoutMs: 20_000,
  allowPrivate: false,
};

/** Accepts an array, a JSON array string, or newline/comma separated text. */
export function toUrlList(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[\n,]+/);
  const urls = [];
  const seen = new Set();
  for (const entry of raw) {
    const trimmed = String(entry ?? '').trim();
    if (!trimmed) continue;
    let normalized;
    try {
      normalized = normalizeFeedUrl(trimmed).href;
    } catch (err) {
      throw new FetchError(`Invalid feed URL "${trimmed}" — ${err.message}`, { code: 'invalid_url' });
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      urls.push(normalized);
    }
  }
  if (!urls.length) throw new FetchError('Provide at least one feed URL', { code: 'no_urls' });
  if (urls.length > LIMITS.maxFeeds) {
    throw new FetchError(`Too many feeds: ${urls.length} (limit ${LIMITS.maxFeeds})`, { code: 'too_many_feeds' });
  }
  return urls;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * @param {Object} request
 * @param {string|string[]} request.feedUrls
 * @param {number} [request.maxItemsPerFeed]
 * @param {boolean} [request.includeContent]
 * @param {boolean} [request.removeDuplicates]
 * @param {number} [request.concurrency]
 * @param {number} [request.timeoutMs]
 * @param {boolean} [request.allowPrivate]
 * @param {(progress: Object) => void} [request.onProgress}
 */
export async function extractFeeds(request = {}) {
  const startedAt = Date.now();
  const options = {
    maxItemsPerFeed: clampInt(request.maxItemsPerFeed, LIMITS.minItemsPerFeed, LIMITS.maxItemsPerFeed, DEFAULTS.maxItemsPerFeed),
    includeContent: request.includeContent !== false && request.includeContent !== 'false',
    removeDuplicates: request.removeDuplicates === true || request.removeDuplicates === 'true',
    concurrency: clampInt(request.concurrency, 1, 20, DEFAULTS.concurrency),
    timeoutMs: clampInt(request.timeoutMs, 1_000, 120_000, DEFAULTS.timeoutMs),
    allowPrivate: request.allowPrivate === true || request.allowPrivate === 'true',
  };

  const urls = toUrlList(request.feedUrls);
  const feeds = [];
  let items = [];
  let totalBytes = 0;

  const results = await mapLimit(urls, options.concurrency, async (url) => {
    const record = { feedUrl: url, ok: false, items: 0, bytes: 0, elapsedMs: 0 };
    try {
      const fetched = await fetchFeed(url, {
        timeoutMs: options.timeoutMs,
        allowPrivate: options.allowPrivate,
      });
      const parsed = parseFeed(fetched.text, fetched.url, {
        maxItemsPerFeed: options.maxItemsPerFeed,
        includeContent: options.includeContent,
        removeDuplicates: options.removeDuplicates,
      });
      record.ok = true;
      record.items = parsed.items.length;
      record.bytes = fetched.bytes;
      record.elapsedMs = fetched.elapsedMs;
      record.feed = parsed.feed;
      record.warnings = parsed.warnings;
      record.parsed = parsed;
      return { kind: 'ok', url, value: parsed, meta: record };
    } catch (err) {
      record.error = err?.message ?? String(err);
      record.code = err?.code ?? 'unknown';
      record.status = err?.status ?? null;
      record.elapsedMs = Date.now() - startedAt;
      return { kind: 'error', url, meta: record, error: err };
    }
  });

  const errors = [];
  for (const result of results) {
    feeds.push(result.meta);
    totalBytes += result.meta.bytes || 0;
    if (result.kind === 'ok') {
      items = items.concat(result.value.items);
    } else {
      errors.push({
        type: 'error',
        feedUrl: result.meta.feedUrl,
        error: result.meta.error,
        code: result.meta.code,
        status: result.meta.status,
      });
    }
  }

  items.forEach((item, i) => { item.index = i + 1; });

  const succeeded = feeds.filter((f) => f.ok).length;
  return {
    items,
    errors,
    feeds: feeds.map(({ parsed, ...meta }) => meta),
    stats: {
      requested: urls.length,
      succeeded,
      failed: urls.length - succeeded,
      totalItems: items.length,
      totalBytes,
      durationMs: Date.now() - startedAt,
    },
    options,
  };
}
