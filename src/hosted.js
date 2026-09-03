/*
 * Browser-side helpers for the hosted build (docs/app/).
 *
 * Must stay free of Node built-ins: tools/build-site.js copies this file verbatim
 * into the Pages artifact and fails the build if it finds any.
 */

import { htmlToText, snippet, toDate } from './feed.js';

export const RSS2JSON_ENDPOINT = 'https://api.rss2json.com/v1/api.json';

/** rss2json parses upstream and will not honour a count without an API key. */
export const RSS2JSON_ITEM_CAP = 10;

/**
 * Runs fn over urls with bounded concurrency. Results are written to indexed
 * slots so the output order matches the input even though fetches race.
 * fn receives (value, index), like Array.prototype.map.
 */
export async function mapPool(urls, limit, fn) {
  const slots = new Array(urls.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < urls.length) {
      const index = cursor++;
      slots[index] = await fn(urls[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, urls.length)) }, worker));
  return slots;
}

/** Builds the response envelope; mirrors extractFeeds() in src/extract.js. */
export function assemblePayload(slots, body, startedAt, transport) {
  const feeds = [];
  const errors = [];
  let items = [];
  let totalBytes = 0;

  for (const { record, items: feedItems } of slots) {
    feeds.push(record);
    totalBytes += record.bytes || 0;
    items = items.concat(feedItems);
    if (!record.ok) {
      errors.push({
        type: 'error',
        feedUrl: record.feedUrl,
        error: record.error,
        code: record.code,
        status: record.status,
      });
    }
  }

  items.forEach((item, i) => { item.index = i + 1; });
  const succeeded = feeds.filter((f) => f.ok).length;

  return {
    items,
    errors,
    feeds,
    stats: {
      requested: body.feedUrls.length,
      succeeded,
      failed: body.feedUrls.length - succeeded,
      totalItems: items.length,
      totalBytes,
      durationMs: Date.now() - startedAt,
    },
    options: { ...body },
    transport,
  };
}

/** Channel record for an rss2json response, shaped like parseFeed()'s feed. */
export function rss2JsonFeed(json, feedUrl) {
  return {
    format: 'rss2json',
    url: feedUrl,
    title: json?.feed?.title || feedUrl,
    description: json?.feed?.description || null,
    link: json?.feed?.link || null,
    language: null,
    generator: 'rss2json',
    lastBuildDate: null,
    image: json?.feed?.image || null,
  };
}

/** Maps one rss2json item onto the field contract src/feed.js defines. */
export function mapRss2JsonItem(raw, feed, feedUrl) {
  const summary = htmlToText(raw.description ?? '') || null;
  const html = raw.content || raw.description || null;
  const contentText = html ? htmlToText(html) : null;
  const enclosure = raw.enclosure && typeof raw.enclosure === 'object' ? raw.enclosure : null;

  const item = {
    type: 'feed_item',
    feedUrl,
    feedTitle: feed.title,
    index: 0,
    id: raw.guid ?? raw.link ?? null,
    title: htmlToText(raw.title ?? '') || '(untitled)',
    link: raw.link ?? null,
    author: raw.author || null,
    authorEmail: null,
    categories: [...new Set((raw.categories ?? []).filter(Boolean).map(String))],
    pubDate: toDate(raw.pubDate ?? ''),
    pubDateRaw: raw.pubDate ?? null,
    summary,
    contentSnippet: snippet(contentText || summary || ''),
    image: raw.thumbnail || feed.image || null,
    audio: enclosure?.link && String(enclosure.type ?? '').startsWith('audio/') ? enclosure.link : null,
    enclosures: enclosure?.link ? [{
      url: enclosure.link,
      mimeType: enclosure.type ?? null,
      lengthBytes: enclosure.length ?? null,
      source: 'rss2json:enclosure',
    }] : [],
    language: null,
    scrapedAt: new Date().toISOString(),
  };
  if (raw.link) item.externalUrl = raw.link;
  item.content = contentText || summary || null;
  item.contentText = contentText || summary || null;
  return item;
}

/** Drops repeats by guid, falling back to title+link when a feed has neither. */
export function dedupe(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.id ?? `${item.title}|${item.link}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
