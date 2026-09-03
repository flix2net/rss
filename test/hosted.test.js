import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapPool, assemblePayload, rss2JsonFeed, mapRss2JsonItem, dedupe,
  RSS2JSON_ENDPOINT, RSS2JSON_ITEM_CAP,
} from '../src/hosted.js';

/** Verbatim shape observed from api.rss2json.com on 2026-09-03. */
const RSS2JSON_RESPONSE = {
  status: 'ok',
  feed: {
    url: 'https://hnrss.org/frontpage',
    title: 'Hacker News: Front Page',
    link: 'https://news.ycombinator.com/',
    author: '',
    description: 'Hacker News RSS',
    image: '',
  },
  items: [
    {
      title: 'Sony makes bold claim about game ownership',
      pubDate: '2026-09-03 15:44:54',
      link: 'https://aginggamer.net/game-industry/sony-makes-bold-claim-about-game-ownership/',
      guid: 'https://news.ycombinator.com/item?id=49551925',
      author: 'speckx',
      thumbnail: '',
      description: '\n<p>Article URL: <a href="https://aginggamer.net/x">https://aginggamer.net/x</a></p>\n',
      content: '\n<p>Article URL: <a href="https://aginggamer.net/x">https://aginggamer.net/x</a></p>\n',
      enclosure: '',
      categories: [],
    },
  ],
};

const okRecord = (feedUrl, items, bytes = 100) => ({
  record: { feedUrl, ok: true, items: items.length, bytes, elapsedMs: 5 }, items,
});
const badRecord = (feedUrl, error) => ({
  record: { feedUrl, ok: false, items: 0, bytes: 0, elapsedMs: 1, error, code: 'x' }, items: [],
});
const item = (title) => ({ type: 'feed_item', title });

test('mapPool keeps input order even when later tasks finish first', async () => {
  const delays = [40, 0, 20];
  const out = await mapPool(delays, 3, async (_, i) => {
    await new Promise((r) => setTimeout(r, delays[i]));
    return `slot-${i}`;
  });
  assert.deepEqual(out, ['slot-0', 'slot-1', 'slot-2']);
});

test('mapPool never exceeds the requested concurrency', async () => {
  let live = 0;
  let peak = 0;
  await mapPool(Array.from({ length: 8 }, (_, i) => i), 3, async () => {
    live += 1;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
  });
  assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
});

test('mapPool with zero urls does not spawn a worker', async () => {
  let ran = 0;
  const out = await mapPool([], 5, async () => { ran += 1; });
  assert.equal(ran, 0);
  assert.deepEqual(out, []);
});

test('assemblePayload mirrors the server envelope', () => {
  const body = { feedUrls: ['a', 'b'], maxItemsPerFeed: 50 };
  const slots = [okRecord('a', [item('one'), item('two')]), badRecord('b', 'boom')];
  const payload = assemblePayload(slots, body, Date.now() - 12, 'relay');

  assert.equal(payload.transport, 'relay');
  assert.equal(payload.items.length, 2);
  assert.deepEqual(payload.items.map((i) => i.index), [1, 2], 'indexes must be global and sequential');
  assert.deepEqual(payload.errors, [{ type: 'error', feedUrl: 'b', error: 'boom', code: 'x', status: undefined }]);
  assert.deepEqual(payload.stats, {
    requested: 2, succeeded: 1, failed: 1, totalItems: 2, totalBytes: 100, durationMs: payload.stats.durationMs,
  }, 'the failed feed contributes no bytes');
  assert.ok(payload.stats.durationMs >= 10);
  assert.equal(payload.options.maxItemsPerFeed, 50);
  assert.notEqual(payload.options, body, 'options is copied, not aliased');
});

test('rss2JsonFeed fills the fields the GUI reads and defaults the rest', () => {
  const feed = rss2JsonFeed(RSS2JSON_RESPONSE, 'https://hnrss.org/frontpage');
  assert.equal(feed.format, 'rss2json');
  assert.equal(feed.title, 'Hacker News: Front Page');
  assert.equal(feed.image, null, 'empty string becomes null so no broken <img> is rendered');

  const bare = rss2JsonFeed(null, 'https://x.test/f');
  assert.equal(bare.title, 'https://x.test/f', 'falls back to the URL so the chip is never blank');
});

test('mapRss2JsonItem produces the same field contract as src/feed.js', () => {
  const feed = rss2JsonFeed(RSS2JSON_RESPONSE, 'https://hnrss.org/frontpage');
  const mapped = mapRss2JsonItem(RSS2JSON_RESPONSE.items[0], feed, 'https://hnrss.org/frontpage');

  assert.equal(mapped.type, 'feed_item');
  assert.equal(mapped.feedUrl, 'https://hnrss.org/frontpage');
  assert.equal(mapped.feedTitle, 'Hacker News: Front Page');
  assert.equal(mapped.title, 'Sony makes bold claim about game ownership');
  assert.equal(mapped.id, 'https://news.ycombinator.com/item?id=49551925');
  assert.equal(mapped.author, 'speckx');
  // rss2json emits "YYYY-MM-DD HH:mm:ss"; toDate must normalise it to ISO.
  assert.equal(mapped.pubDate, '2026-09-03T15:44:54.000Z');
  assert.equal(mapped.pubDateRaw, '2026-09-03 15:44:54');
  assert.equal(mapped.summary, 'Article URL: https://aginggamer.net/x');
  assert.equal(mapped.contentText, 'Article URL: https://aginggamer.net/x');
  assert.equal(mapped.image, null);
  assert.deepEqual(mapped.enclosures, []);
  assert.equal(mapped.audio, null);
});

test('mapRss2JsonItem matches the key set the local parser emits', async () => {
  const { parseFeed } = await import('../src/feed.js');
  const local = parseFeed(
    '<?xml version="1.0"?><rss><channel><title>T</title><item><title>i</title></item></channel></rss>',
    'https://x.test/f', {},
  ).items[0];
  const feed = rss2JsonFeed(RSS2JSON_RESPONSE, 'https://x.test/f');
  const mapped = mapRss2JsonItem(RSS2JSON_RESPONSE.items[0], feed, 'https://x.test/f');

  const localOnly = Object.keys(local).filter((k) => !(k in mapped));
  assert.deepEqual(localOnly, [], `hosted items are missing fields the GUI may read: ${localOnly.join(', ')}`);
});

test('mapRss2JsonItem tolerates a missing title and a null enclosure', () => {
  const feed = rss2JsonFeed(RSS2JSON_RESPONSE, 'https://x.test/f');
  const mapped = mapRss2JsonItem({ pubDate: '', categories: null }, feed, 'https://x.test/f');
  assert.equal(mapped.title, '(untitled)');
  assert.equal(mapped.id, null);
  assert.deepEqual(mapped.categories, []);
  assert.equal(mapped.pubDate, null);
});

test('mapRss2JsonItem surfaces an audio enclosure', () => {
  const feed = rss2JsonFeed({ feed: { title: 'Show' } }, 'https://x.test/f');
  const mapped = mapRss2JsonItem({
    title: 'Ep 1',
    enclosure: { link: 'https://cdn.test/e1.mp3', type: 'audio/mpeg', length: '40000' },
  }, feed, 'https://x.test/f');

  assert.equal(mapped.audio, 'https://cdn.test/e1.mp3');
  assert.deepEqual(mapped.enclosures, [{
    url: 'https://cdn.test/e1.mp3', mimeType: 'audio/mpeg', lengthBytes: '40000', source: 'rss2json:enclosure',
  }]);
});

test('dedupe drops repeats by id and falls back to title+link', () => {
  const items = [
    { id: 'a', title: 'A', link: '1' },
    { id: 'a', title: 'A', link: '1' },
    { id: null, title: 'B', link: '2' },
    { id: null, title: 'B', link: '2' },
    { id: 'c', title: 'A', link: '1' },
  ];
  assert.deepEqual(dedupe(items).map((i) => i.id ?? i.title), ['a', 'B', 'c']);
});

test('the demo endpoint and its cap are what the UI promises', () => {
  assert.equal(RSS2JSON_ENDPOINT, 'https://api.rss2json.com/v1/api.json');
  assert.equal(RSS2JSON_ITEM_CAP, 10);
});
