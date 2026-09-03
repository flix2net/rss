import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseOpml, toOpml, looksLikeOpml, untitledFeeds } from '../src/opml.js';

// Shape exported by Feedly/Inoreader: nested folders, text+title on both kinds.
const NESTED = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My subscriptions</title></head>
  <body>
    <outline text="News" title="News">
      <outline text="World">
        <outline type="rss" text="BBC News" title="BBC News"
                 xmlUrl="https://feeds.bbci.co.uk/news/rss.xml"
                 htmlUrl="https://www.bbc.co.uk/news"/>
        <outline type="rss" text="The Verge" xmlUrl="https://www.theverge.com/rss/index.xml"/>
      </outline>
      <outline type="rss" text="HN Front" xmlUrl="https://hnrss.org/frontpage"/>
    </outline>
    <outline text="Tech" title="Tech">
      <outline type="rss" text="Ars" xmlUrl="https://feeds.arstechnica.com/arstechnica/index"/>
    </outline>
    <outline type="rss" text="Loose feed" xmlUrl="https://example.com/feed.xml"/>
  </body>
</opml>`;

test('nested outlines become feeds with their folder path', () => {
  const { feeds, folders, warnings } = parseOpml(NESTED);

  assert.equal(feeds.length, 5);
  assert.deepEqual(folders.sort(), ['News', 'News/World', 'Tech']);
  assert.deepEqual(warnings, []);

  const bbc = feeds.find((f) => f.title === 'BBC News');
  assert.equal(bbc.url, 'https://feeds.bbci.co.uk/news/rss.xml');
  assert.equal(bbc.folder, 'News/World', 'folder is the full ancestor trail');
  assert.equal(bbc.siteUrl, 'https://www.bbc.co.uk/news');
  assert.equal(bbc.type, 'rss');

  assert.equal(feeds.find((f) => f.title === 'Loose feed').folder, null);
});

test('title falls back through text, title, label, then the URL host', () => {
  const { feeds } = parseOpml(`<opml><body>
    <outline text="T1" xmlUrl="https://a.test/f"/>
    <outline title="T2" xmlUrl="https://b.test/f"/>
    <outline label="T3" xmlUrl="https://c.test/f"/>
    <outline xmlUrl="https://example.org/dir/feed.xml"/>
  </body></opml>`);
  assert.deepEqual(feeds.map((f) => f.title), ['T1', 'T2', 'T3', 'example.org/dir/feed.xml']);
});

test('xmlUrl is matched case-insensitively, as real exporters vary', () => {
  const { feeds } = parseOpml(`<opml><body>
    <outline text="A" xmlurl="https://a.test/f"/>
    <outline text="B" URL="https://b.test/f"/>
  </body></opml>`);
  assert.deepEqual(feeds.map((f) => f.url), ['https://a.test/f', 'https://b.test/f']);
});

test('folder-only outlines and empty junk are handled, not invented into feeds', () => {
  const { feeds, warnings } = parseOpml(`<opml><body>
    <outline text="Empty folder"/>
    <outline text="No url"/>
    <outline text="Real" xmlUrl="https://x.test/feed"/>
  </body></opml>`);
  assert.equal(feeds.length, 1);
  assert.match(warnings.join(' '), /2 outline\(s\) had no xmlUrl/);
});

test('a document with no body reports rather than throwing', () => {
  const { feeds, warnings } = parseOpml('<?xml version="1.0"?><opml version="2.0"><head/></opml>');
  assert.deepEqual(feeds, []);
  assert.match(warnings.join(' '), /No <body>/);
});

test('garbage input yields no feeds and never throws', () => {
  for (const junk of ['', 'not xml at all', '<opml><body>', '<?xml version="1.0"?><nothing/>']) {
    assert.doesNotThrow(() => parseOpml(junk));
    assert.equal(parseOpml(junk).feeds.length, 0, `expected no feeds from ${JSON.stringify(junk)}`);
  }
});

test('entities in titles are decoded', () => {
  const { feeds } = parseOpml(`<opml><body>
    <outline text="Salt &amp; Pepper" xmlUrl="https://sp.test/feed"/>
    <outline text="Quotes &quot;here&quot;" xmlUrl="https://q.test/feed"/>
  </body></opml>`);
  assert.deepEqual(feeds.map((f) => f.title), ['Salt & Pepper', 'Quotes "here"']);
});

test('an unterminated outline recovers without throwing or inventing feeds', () => {
  // Note the missing ">" after the self-closing slash — exporters do emit this.
  const { feeds } = parseOpml(`<opml><body>
    <outline text="Salt &amp; Pepper" xmlUrl="https://sp.test/feed"/
    <outline text="Quotes &quot;here&quot;" xmlUrl="https://q.test/feed"/>
  </body></opml>`);
  assert.ok(feeds.length >= 1, 'should salvage at least one feed');
  for (const feed of feeds) assert.match(feed.url, /^https?:\/\//);
});

test('looksLikeOpml separates OPML from feeds', () => {
  assert.equal(looksLikeOpml(NESTED), true);
  assert.equal(looksLikeOpml('<opml version="1.0"><body></body></opml>'), true);
  // A bare outline list with no <opml> wrapper is still OPML in practice.
  assert.equal(looksLikeOpml('<opml><body><outline xmlUrl="https://x.test/f"/></body></opml>'), true);
  assert.equal(looksLikeOpml('<?xml version="1.0"?><rss><channel><item/></channel></rss>'), false);
  assert.equal(looksLikeOpml('{"version":"https://jsonfeed.org/version/1.1"}'), false);
  assert.equal(looksLikeOpml(''), false);
});

test('toOpml round-trips folders and feeds back to the same set', () => {
  const original = parseOpml(NESTED);
  const serialised = toOpml(original.feeds, { title: 'Round trip' });
  const again = parseOpml(serialised);

  assert.deepEqual(again.feeds.map((f) => `${f.folder}|${f.url}`).sort(),
    original.feeds.map((f) => `${f.folder}|${f.url}`).sort());
  assert.match(serialised, /^<\?xml version="1\.0" encoding="UTF-8"\?>\n<opml version="2\.0">/);
  assert.match(serialised, /<title>Round trip<\/title>/);
});

test('toOpml escapes attribute values so titles cannot break the document', () => {
  const out = toOpml([{ title: 'A & B <c> "d"', url: 'https://x.test/f?a=1&b=2' }]);
  assert.match(out, /text="A &amp; B &lt;c&gt; &quot;d&quot;"/);
  assert.match(out, /xmlUrl="https:\/\/x\.test\/f\?a=1&amp;b=2"/);
  // And it must survive being read back.
  assert.equal(parseOpml(out).feeds[0].title, 'A & B <c> "d"');
});

test('untitledFeeds flags rows that would export blank', () => {
  const { feeds } = parseOpml('<opml><body><outline xmlUrl="https://x.test/f"/></body></opml>');
  assert.equal(untitledFeeds(feeds).length, 1);
  assert.equal(untitledFeeds([{ title: 'Named', url: 'https://x.test/f' }]).length, 0);
});
