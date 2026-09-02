import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFeed, toDate, htmlToText, snippet, LIMITS } from '../src/feed.js';
import { decodeEntities, parseXml } from '../src/xml.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
     xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
  <channel>
    <title>Example Weekly</title>
    <link>https://example.com/</link>
    <description>Things that happened</description>
    <language>en-us</language>
    <image><url>https://example.com/logo.png</url><title>Example Weekly</title></image>
    <item>
      <title>Tea &amp; Toast: a &lt;study&gt;</title>
      <link>https://example.com/tea</link>
      <guid isPermaLink="false">tag:example,2026:tea</guid>
      <dc:creator>Jane Doe (jane@example.com)</dc:creator>
      <pubDate>Tue, 02 Sep 2026 08:30:00 GMT</pubDate>
      <category>food</category>
      <category>culture</category>
      <description><![CDATA[<p>She <b>liked</b> the toast.</p>]]></description>
      <content:encoded><![CDATA[<div><p>A longer body with an <a href="https://example.com/x">inline link</a> &amp; more.</p></div>]]></content:encoded>
      <enclosure url="https://example.com/tea.mp3" length="102400" type="audio/mpeg"/>
      <media:thumbnail url="https://example.com/tea-640.jpg" width="640" height="360"/>
      <media:thumbnail url="https://example.com/tea-120.jpg" width="120" height="60"/>
    </item>
    <item>
      <title>Second item</title>
      <link>https://example.com/two</link>
      <pubDate>not a real date</pubDate>
    </item>
  </channel>
</rss>`;

test('RSS 2.0: channel metadata', () => {
  const { feed, items } = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(feed.format, 'rss2');
  assert.equal(feed.title, 'Example Weekly');
  assert.equal(feed.link, 'https://example.com/');
  assert.equal(feed.language, 'en-us');
  assert.equal(feed.image, 'https://example.com/logo.png');
  assert.equal(items.length, 2);
});

test('RSS 2.0: item fields, entities and dates', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed.xml');
  const [tea] = items;
  assert.equal(tea.type, 'feed_item');
  assert.equal(tea.title, 'Tea & Toast: a <study>');
  assert.equal(tea.link, 'https://example.com/tea');
  assert.equal(tea.id, 'tag:example,2026:tea');
  assert.equal(tea.pubDate, '2026-09-02T08:30:00.000Z');
  assert.deepEqual(tea.categories, ['food', 'culture']);
  assert.equal(tea.author, 'Jane Doe');
  assert.equal(tea.authorEmail, 'jane@example.com');
  assert.equal(tea.feedTitle, 'Example Weekly');
});

test('RSS 2.0: content, plain-text conversion and snippet', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed.xml');
  const [tea] = items;
  assert.match(tea.content, /<a href="https:\/\/example\.com\/x">/);
  assert.equal(tea.contentText, 'A longer body with an inline link & more.');
  assert.equal(tea.summary, 'She liked the toast.');
  assert.ok(tea.contentSnippet.startsWith('A longer body'));
});

test('RSS 2.0: media picks the largest thumbnail and keeps the audio enclosure', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed.xml');
  const [tea] = items;
  assert.equal(tea.image, 'https://example.com/tea-640.jpg');
  assert.equal(tea.audio, 'https://example.com/tea.mp3');
  assert.equal(tea.enclosures[0].mimeType, 'audio/mpeg');
  assert.equal(tea.enclosures[0].lengthBytes, 102400);
});

test('RSS 2.0: an unparseable date yields null but keeps the raw string', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed.xml');
  assert.equal(items[1].pubDate, null);
  assert.equal(items[1].pubDateRaw, 'not a real date');
});

test('includeContent: false drops the heavy fields only', () => {
  const { items } = parseFeed(RSS, 'https://example.com/feed.xml', { includeContent: false });
  assert.equal('content' in items[0], false);
  assert.equal('contentText' in items[0], false);
  assert.equal(items[0].summary, 'She liked the toast.');
});

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Example</title>
  <link rel="self" href="https://blog.example/atom.xml"/>
  <link rel="alternate" href="https://blog.example/"/>
  <updated>2026-09-01T12:00:00Z</updated>
  <entry>
    <title>Relative links</title>
    <link rel="edit" href="/entries/1"/>
    <link href="/entries/1/edit"/>
    <link rel="alternate" type="text/html" href="/posts/relative"/>
    <id>tag:blog.example,2026:/posts/relative</id>
    <updated>2026-09-01T11:00:00-04:00</updated>
    <author><name>Ada</name><email>ada@example.org</email></author>
    <category term="builds" scheme="https://blog.example/tags"/>
    <summary>Short</summary>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>Body with <code>code</code></p></div></content>
  </entry>
</feed>`;

test('Atom: prefers rel=alternate and resolves it against the feed URL', () => {
  const { feed, items } = parseFeed(ATOM, 'https://blog.example/atom.xml');
  assert.equal(feed.format, 'atom');
  assert.equal(feed.link, 'https://blog.example/');
  assert.equal(items.length, 1);
  assert.equal(items[0].link, 'https://blog.example/posts/relative');
  assert.equal(items[0].author, 'Ada');
  assert.equal(items[0].authorEmail, 'ada@example.org');
  assert.deepEqual(items[0].categories, ['builds']);
  assert.equal(items[0].pubDate, '2026-09-01T15:00:00.000Z');
  assert.equal(items[0].contentText, 'Body with code');
});

const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
         xmlns="http://purl.org/rss/1.0/"
         xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example/index.xml">
    <title>RSS 1.0 sample</title>
    <link>https://old.example/</link>
    <description>Old but valid</description>
    <items><rdf:Seq><rdf:li rdf:resource="https://old.example/a"/></rdf:Seq></items>
  </channel>
  <item rdf:about="https://old.example/a">
    <title>First RDF item</title>
    <link>https://old.example/a</link>
    <dc:date>2026-08-30</dc:date>
    <dc:creator>Sam</dc:creator>
    <description>Hello</description>
  </item>
</rdf:RDF>`;

test('RSS 1.0 (RDF): items are found outside the channel', () => {
  const { feed, items } = parseFeed(RDF, 'https://old.example/index.xml');
  assert.equal(feed.format, 'rss1');
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'First RDF item');
  assert.equal(items[0].link, 'https://old.example/a');
  assert.equal(items[0].pubDate, '2026-08-30T00:00:00.000Z');
  assert.equal(items[0].author, 'Sam');
});

const YT = `<?xml version="1.0"?>
<feed xmlns:media="http://search.yahoo.com/mrss/" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <entry>
    <id>yt:video:abc123</id>
    <media:group>
      <media:title>Nested title</media:title>
      <media:description>Nested description</media:description>
      <media:thumbnail url="https://i.example/hq.jpg" width="480" height="360"/>
    </media:group>
    <media:thumbnail url="https://i.example/default.jpg" width="120"/>
    <link rel="alternate" type="text/html" href="https://youtube.com/watch?v=abc123"/>
    <published>2026-09-02T01:02:03+00:00</published>
  </entry>
</feed>`;

test('media:group: falls back to nested title/description', () => {
  const { items } = parseFeed(YT, 'https://www.youtube.com/feeds/videos.xml?channel_id=x');
  assert.equal(items[0].title, 'Nested title');
  assert.equal(items[0].summary, 'Nested description');
  assert.equal(items[0].image, 'https://i.example/hq.jpg');
  assert.equal(items[0].id, 'yt:video:abc123');
});

test('malformed feeds still yield readable items', () => {
  const broken = `<?xml version="1.0" encoding="utf-8"?>
<rss><channel><title>Broken</title>
  <item><title>Unclosed &amp missing semicolon<guid>x1</guid>
  <description><![CDATA[<p>HTML <3 inside]]></description></item>
  <item><title>Second</title><link>https://b.example/2</link></item>
  <item><title>Third</title><link>https://b.example/3</link></item>
</channel></rss>`;
  const { items } = parseFeed(broken, 'https://b.example/feed');
  assert.equal(items.length, 3, `expected 3 items, got ${items.length}`);
  assert.equal(items[0].title, 'Unclosed & missing semicolon');
  assert.equal(items[0].id, 'x1');
  assert.equal(items[0].contentText, 'HTML <3 inside');
  assert.equal(items[1].link, 'https://b.example/2');
  assert.equal(items[2].link, 'https://b.example/3');

  const capped = parseFeed(broken, 'https://b.example/feed', { maxItemsPerFeed: 2 });
  assert.equal(capped.items.length, 2);
  assert.ok(capped.warnings.some((w) => w.includes('Truncated')), 'expected a truncation warning');
});

test('inline <img> in content HTML is used as the thumbnail fallback', () => {
  const inline = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Blog</title>
  <entry><title>With hero image</title><link rel="alternate" href="/post/1"/>
    <id>https://blog.example/post/1</id>
    <content type="html"><![CDATA[<figure><img alt="" data-src="/lazy.png"/><img src="https://cdn.example/hero.jpg?w=1200"/></figure><p>Text</p>]]></content>
  </entry>
  <entry><title>No image at all</title><link rel="alternate" href="/post/2"/>
    <id>https://blog.example/post/2</id><content type="html"><p>Text only</p></content>
  </entry>
</feed>`;
  const { items } = parseFeed(inline, 'https://blog.example/atom.xml');
  assert.equal(items[0].image, 'https://cdn.example/hero.jpg?w=1200');
  assert.equal(items[1].image, null);
});

test('maxItemsPerFeed clamps into the supported range', () => {
  const many = `<rss><channel><title>M</title>${
    Array.from({ length: 12 }, (_, i) => `<item><title>i${i}</title></item>`).join('')
  }</channel></rss>`;
  assert.equal(parseFeed(many, 'https://m.example/f', { maxItemsPerFeed: 5 }).items.length, 5);
  assert.equal(parseFeed(many, 'https://m.example/f', { maxItemsPerFeed: 9999 }).items.length, 12);
  assert.equal(parseFeed(many, 'https://m.example/f', { maxItemsPerFeed: 0 }).items.length, 12);

  const huge = `<rss><channel><title>M</title>${
    Array.from({ length: LIMITS.maxItemsPerFeed + 5 }, (_, i) => `<item><title>i${i}</title></item>`).join('')
  }</channel></rss>`;
  assert.equal(parseFeed(huge, 'https://m.example/f', { maxItemsPerFeed: 9999 }).items.length, LIMITS.maxItemsPerFeed);
});

test('removeDuplicates collapses by id or link', () => {
  const dupes = `<rss><channel><title>D</title>
    <item><title>a</title><guid>1</guid><link>https://d.example/1</link></item>
    <item><title>a again</title><guid>1</guid><link>https://d.example/1</link></item>
    <item><title>b</title><guid>2</guid><link>https://d.example/2</link></item>
  </channel></rss>`;
  const { items, warnings } = parseFeed(dupes, 'https://d.example/f', { removeDuplicates: true });
  assert.equal(items.length, 2);
  assert.ok(warnings.some((w) => w.includes('duplicate')));
});

const JSONFEED = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Feed sample',
  home_page_url: 'https://jf.example/',
  items: [{
    id: '1',
    url: 'https://jf.example/one',
    title: 'One',
    content_html: '<p>Hello &amp; welcome</p>',
    date_published: '2026-09-01T00:00:00Z',
    tags: ['a', 'b'],
    authors: [{ name: 'Ada' }],
    attachments: [{ url: 'https://jf.example/e.mp3', mime_type: 'audio/mpeg', size_in_bytes: 10 }],
  }],
});

test('JSON Feed 1.1', () => {
  const { feed, items } = parseFeed(JSONFEED, 'https://jf.example/feed.json');
  assert.equal(feed.format, 'json-feed');
  assert.equal(items[0].link, 'https://jf.example/one');
  assert.equal(items[0].contentText, 'Hello & welcome');
  assert.equal(items[0].author, 'Ada');
  assert.deepEqual(items[0].categories, ['a', 'b']);
  assert.equal(items[0].audio, 'https://jf.example/e.mp3');
});

test('rejects non-feed documents with a useful message', () => {
  assert.throws(() => parseFeed('<html><body>nope</body></html>', 'https://x.example'), /Unrecognised document root/);
  assert.throws(() => parseFeed('   ', 'https://x.example'), /empty/);
  assert.throws(() => parseFeed('{"foo": 1}', 'https://x.example'), /no `items` array/);
});

test('toDate handles the spellings that appear in real feeds', () => {
  assert.equal(toDate('2026-09-02T08:30:00Z'), '2026-09-02T08:30:00.000Z');
  assert.equal(toDate('2026-09-02T08:30:00'), '2026-09-02T08:30:00.000Z');
  assert.equal(toDate('2026-09-02 08:30:00'), '2026-09-02T08:30:00.000Z');
  assert.equal(toDate('2026-09-02'), '2026-09-02T00:00:00.000Z');
  assert.equal(toDate('2026-09-02T08:30:00+02:00'), '2026-09-02T06:30:00.000Z');
  assert.equal(toDate('1756800000'), new Date(1756800000 * 1000).toISOString());
  assert.equal(toDate('yesterday'), null);
  assert.equal(toDate(''), null);
});

test('htmlToText drops script bodies and keeps line structure', () => {
  const html = '<div><script>var x = "<b>nuke</b>";</script><h2>Head</h2><p>One</p><ul><li>a</li><li>b</li></ul></div>';
  assert.equal(htmlToText(html), 'Head\nOne\n- a\n- b');
  assert.equal(htmlToText('Tea &amp; <b>toast</b>'), 'Tea & toast');
});

test('decodeEntities tolerates missing semicolons and leaves unknowns alone', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('a &amp b'), 'a & b');
  assert.equal(decodeEntities('&#8217;'), '\u2019');
  assert.equal(decodeEntities('&#x2014'), '\u2014');
  assert.equal(decodeEntities('https://x.example/?a=1&b=2'), 'https://x.example/?a=1&b=2');
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;');
});

test('parseXml indexes namespaced attributes by local name too', () => {
  const root = parseXml('<r xmlns:r="urn:x"><r:child r:about="u1"/></r>');
  const child = root.children.find((c) => c.type === 'element');
  assert.equal(child.attrs.about, 'u1');
  assert.equal(child.attrs['r:about'], 'u1');
});

test('snippet cuts on a word boundary', () => {
  const long = 'word '.repeat(100).trim();
  const out = snippet(long, 20);
  assert.ok(out.length <= 21);
  assert.ok(out.endsWith('…'));
  assert.equal(out.includes('  '), false);
});
