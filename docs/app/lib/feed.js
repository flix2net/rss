/**
 * Maps RSS 2.0, Atom 1.0, RSS 1.0 (RDF) and JSON Feed documents onto one flat
 * item record. Everything here is best-effort by design: a feed that is half
 * broken should still yield the items that are readable.
 */

import {
  parseXml, getAttr, textOf, rawTextOf, decodeEntities,
} from './xml.js';

const DC = 'http://purl.org/dc/elements/1.1/';
const DCTERMS = 'http://purl.org/dc/terms/';
const CONTENT_NS = 'http://purl.org/rss/1.0/modules/content/';
const MEDIA_NS = 'http://search.yahoo.com/mrss/';
const ITUNES_NS = 'http://www.itunes.com/dtds/podcast-1.0.dtd';
const ATOM_NS = 'http://www.w3.org/2005/Atom';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const WEBFEEDS_NS = 'http://webfeeds.org/rss/1.0';

export const LIMITS = {
  minItemsPerFeed: 1,
  maxItemsPerFeed: 500,
  defaultItemsPerFeed: 50,
  maxFeeds: 200,
  maxBytes: 12 * 1024 * 1024,
  snippetLength: 280,
};

/* ------------------------------------------------------------------ helpers */

const isElement = (n) => n && n.type === 'element';

/** Parse failures carry a stable code so callers can tell them from network errors. */
function parseError(message) {
  return Object.assign(new Error(message), { code: 'parse_failed' });
}

const sameNs = (el, uris) => {
  const wanted = Array.isArray(uris) ? uris : [uris];
  if (el.uri) return wanted.includes(el.uri);
  return false;
};

function direct(el, local, uris) {
  if (!isElement(el)) return [];
  return (el.children ?? []).filter((c) => {
    if (!isElement(c)) return false;
    if (c.local.toLowerCase() !== local.toLowerCase()) return false;
    return uris ? sameNs(c, uris) || (!c.uri && c.prefix && matchesPrefixFallback(c, uris)) : true;
  });
}

function matchesPrefixFallback(el, uris) {
  const wanted = Array.isArray(uris) ? uris : [uris];
  const known = el.prefix && WELL_KNOWN[el.prefix.toLowerCase()];
  return known ? wanted.includes(known) : false;
}

const WELL_KNOWN = {
  content: CONTENT_NS, dc: DC, dcterms: DCTERMS, media: MEDIA_NS, mrss: MEDIA_NS,
  itunes: ITUNES_NS, atom: ATOM_NS,
};

function descendants(el, local, uris, depth = 0, acc = [], skipContainers = false) {
  if (!isElement(el) || depth > 6) return acc;
  for (const c of el.children ?? []) {
    if (!isElement(c)) continue;
    // Feed-level lookups must not reach into individual items.
    if (skipContainers && (c.local === 'item' || c.local === 'entry')) continue;
    if (c.local.toLowerCase() === local.toLowerCase() && (!uris || sameNs(c, uris) || matchesPrefixFallback(c, uris))) {
      acc.push(c);
    }
    descendants(c, local, uris, depth + 1, acc, skipContainers);
  }
  return acc;
}

function firstText(el, local, uris) {
  for (const c of direct(el, local, uris)) {
    const v = textOf(c).trim();
    if (v) return v;
  }
  return '';
}

/** As `firstText`, but markup/entities are left untouched (for HTML-bearing fields). */
function firstRaw(el, local, uris) {
  for (const c of direct(el, local, uris)) {
    const v = rawTextOf(c).trim();
    if (v) return v;
  }
  return '';
}

/**
 * Reads a text field, also looking inside `<media:group>` — YouTube, Vimeo and
 * BBC podcast feeds nest the real title/description there.
 */
function mediaAwareText(item, local, uris) {
  const own = firstText(item, local, uris);
  if (own) return own;
  for (const group of direct(item, 'group', MEDIA_NS)) {
    const v = firstText(group, local, uris);
    if (v) return v;
  }
  return '';
}

function mediaAwareRaw(item, local, uris) {
  const own = firstRaw(item, local, uris);
  if (own) return own;
  for (const group of direct(item, 'group', MEDIA_NS)) {
    const v = firstRaw(group, local, uris);
    if (v) return v;
  }
  return '';
}

/** Collapses a `<person>`-ish string: "Jane Doe (jane@example.com)". */
function parseAuthor(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/\s+/g, ' ');
  const m = s.match(/^(.*?)\s*\(([^()]+@[^()]+)\)$/) || s.match(/^([^()<>]+<[^<>@]+@[^<>]+>)$/);
  if (m) {
    const name = (m[1] || '').trim();
    const email = (m[2] ?? s).replace(/^[^<]*</, '<').replace(/>$/, '').trim();
    if (name || email) return { name: name || null, email: email || null, raw: s };
  }
  if (s.includes('@') && !s.includes(' ')) return { name: null, email: s, raw: s };
  return { name: s, email: null, raw: s };
}

/**
 * Normalises the many date spellings seen in feeds to an ISO-8601 string.
 * @returns {string|null}
 */
export function toDate(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  if (/^\d{9,10}$/.test(s)) return iso(Number(s) * 1000);
  if (/^\d{13}$/.test(s)) return iso(Number(s));

  // ISO-ish without a zone: syndication feeds almost always mean UTC.
  const isoish = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (isoish && !isoish[7]) {
    const [, y, mo, d, h = '00', mi = '00', sec = '00'] = isoish;
    return iso(Date.UTC(+y, +mo - 1, +d, +h, +mi, +sec));
  }
  if (isoish && isoish[7]) {
    const zone = isoish[7] === 'Z' ? 'Z' : `${isoish[7].slice(0, 3)}:${isoish[7].replace(/[+-]/, '').slice(-2)}`;
    const rebuilt = `${isoish[1]}-${isoish[2]}-${isoish[3]}T${isoish[4] ?? '00'}:${isoish[5] ?? '00'}:${isoish[6] ?? '00'}${zone}`;
    return iso(Date.parse(rebuilt));
  }

  // RFC 822 with a two-digit year or a missing weekday, e.g. "02 Jan 24 03:04:05 GMT".
  const relaxed = s.replace(/^[A-Za-z]{3},?\s+/, '').replace(/\b(\d{2})\s+(\d{2}:\d{2})/, '20$1 $2');
  const parsed = Date.parse(s) || Date.parse(relaxed);
  return Number.isFinite(parsed) ? iso(parsed) : null;

  function iso(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
}

/**
 * Turns feed markup into readable plain text. Script/style bodies are dropped
 * outright rather than left as stray words.
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*(script|style|noscript)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  s = s.replace(/<\s*(script|style)\b[^>]*\/?>/gi, ' ');
  s = s.replace(/<\s*(br|hr)\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|li|ul|ol|tr|table|h[1-6]|blockquote|figure|figcaption|article|section|pre)\s*>/gi, '\n');
  s = s.replace(/<\s*li\b[^>]*>/gi, '\n- ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ').replace(/[\t\f\v ]+/g, ' ');
  s = s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n');
  // A bullet never needs a blank line above it, but a real paragraph break does.
  s = s.replace(/\n{2,}(?=- )/g, '\n');
  return s.trim();
}

export function snippet(text, length = LIMITS.snippetLength) {
  if (!text) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= length) return flat;
  const cut = flat.slice(0, length);
  const at = cut.lastIndexOf(' ');
  return `${(at > length * 0.6 ? cut.slice(0, at) : cut).trimEnd()}…`;
}

function absoluteUrl(base, href) {
  if (!href) return null;
  try {
    return new URL(String(href).trim(), base).href;
  } catch {
    return String(href).trim() || null;
  }
}

function splitList(raw, separators = /[,;]/) {
  if (!raw) return [];
  return [...new Set(
    String(raw).split(separators).map((t) => t.trim()).filter(Boolean),
  )];
}

/* -------------------------------------------------------------- media/links */

/** Recursive search that stops at item/entry boundaries (safe for feed-level use). */
function deep(el, local, uris) {
  return descendants(el, local, uris, 0, [], true);
}

function collectImages(el) {
  const found = [];
  const push = (url, extra = {}) => {
    if (!url) return;
    found.push({ url, ...extra });
  };

  for (const t of deep(el, 'thumbnail', MEDIA_NS)) {
    push(getAttr(t, 'url'), { width: num(getAttr(t, 'width')), height: num(getAttr(t, 'height')), source: 'media:thumbnail' });
  }
  for (const c of deep(el, 'content', MEDIA_NS)) {
    const medium = (getAttr(c, 'medium') ?? '').toLowerCase();
    const type = (getAttr(c, 'type') ?? '').toLowerCase();
    if (medium === 'image' || type.startsWith('image/')) {
      push(getAttr(c, 'url'), { width: num(getAttr(c, 'width')), height: num(getAttr(c, 'height')), source: 'media:content' });
    }
  }
  for (const i of deep(el, 'image')) {
    const href = getAttr(i, 'href');
    const url = href || firstText(i, 'url') || textOf(i).trim();
    if (url && /^https?:/i.test(url)) {
      push(url, { width: num(getAttr(i, 'width')), height: num(getAttr(i, 'height')), source: el.local === 'item' ? 'image' : 'feed-image' });
    }
  }
  for (const i of deep(el, 'image', ITUNES_NS)) {
    push(getAttr(i, 'href'), { source: 'itunes:image' });
  }
  for (const e of direct(el, 'enclosure')) {
    const type = (getAttr(e, 'type') ?? '').toLowerCase();
    if (type.startsWith('image/')) push(getAttr(e, 'url'), { type, source: 'enclosure' });
  }
  for (const f of deep(el, 'favicon', WEBFEEDS_NS)) {
    const url = getAttr(f, 'url') || textOf(f).trim();
    push(url, { source: 'webfeeds:favicon' });
  }

  const seen = new Set();
  return found
    .filter((c) => c.url && !seen.has(c.url) && seen.add(c.url))
    .sort((a, b) => (b.width ?? 0) * (b.height ?? 0) - (a.width ?? 0) * (a.height ?? 0));
}

function num(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function collectEnclosures(item) {
  const out = [];
  for (const e of direct(item, 'enclosure')) {
    const url = getAttr(e, 'url');
    if (!url) continue;
    out.push({
      url,
      mimeType: getAttr(e, 'type') ?? null,
      lengthBytes: num(getAttr(e, 'length')),
      source: 'enclosure',
    });
  }
  for (const c of descendants(item, 'content', MEDIA_NS)) {
    const url = getAttr(c, 'url');
    if (!url) continue;
    const medium = (getAttr(c, 'medium') ?? '').toLowerCase();
    const type = (getAttr(c, 'type') ?? '').toLowerCase();
    if (medium === 'image' || type.startsWith('image/')) continue;
    out.push({
      url,
      mimeType: type || (medium ? medium : null),
      lengthBytes: num(getAttr(c, 'fileSize')),
      source: 'media:content',
    });
  }
  const seen = new Set();
  return out.filter((e) => !seen.has(e.url) && seen.add(e.url));
}

const IMG_SRC_PATTERNS = [
  // `(?<![-\w:])src` so that `data-src` / `data-lazy-src` cannot match first.
  /<img\b[^>]*?(?<![-\w:])src\s*=\s*["']([^"']+)["']/gi,
  /<img\b[^>]*?\bdata-src\s*=\s*["']([^"']+)["']/gi,
  /<img\b[^>]*?\bdata-lazy-src\s*=\s*["']([^"']+)["']/gi,
];

/**
 * Last-resort thumbnail: many Atom feeds (Verge, Wired) embed the hero image as
 * a plain `<img>` inside the content HTML instead of using Media RSS.
 */
function inlineImage(html, baseUrl) {
  if (!html) return null;
  for (const pattern of IMG_SRC_PATTERNS) {
    for (const m of html.matchAll(pattern)) {
      const url = absoluteUrl(baseUrl, decodeEntities(m[1].trim()));
      if (url && /^https?:/i.test(url) && !/\.(svg|gif)($|\?)/i.test(url)) return url;
    }
  }
  return null;
}

/** Atom links carry semantics in `rel`; RSS links are just text. */
function resolveLink(item, feedUrl) {
  const atomLinks = direct(item, 'link').filter((l) => getAttr(l, 'href'));
  if (atomLinks.length) {
    const rank = (l) => {
      const rel = getAttr(l, 'rel');
      const type = (getAttr(l, 'type') ?? '').toLowerCase();
      if (!rel) return 1; // bare <link href> is an implicit alternate
      const key = rel.toLowerCase();
      if (key === 'alternate') return 0;
      if (key === 'related') return 2;
      if (key === 'enclosure' || type.startsWith('image/')) return 4;
      if (['self', 'edit', 'hub', 'first', 'last', 'prev', 'previous', 'next', 'current', 'version-history', 'via', 'payment'].includes(key)) return 5;
      return 3;
    };
    const best = [...atomLinks].sort((a, b) => rank(a) - rank(b))[0];
    if (rank(best) < 5) return absoluteUrl(feedUrl, getAttr(best, 'href'));
    const any = atomLinks.find((l) => rank(l) < 5);
    if (any) return absoluteUrl(feedUrl, getAttr(any, 'href'));
  }
  const plain = firstText(item, 'link') || getAttr(item, 'about') || '';
  return plain ? absoluteUrl(feedUrl, plain) : null;
}

/* ------------------------------------------------------------- item mapping */

function mapItem(node, ctx) {
  const { feedUrl, feedTitle, includeContent, index } = ctx;

  const title = mediaAwareText(node, 'title') || mediaAwareText(node, 'headline');
  const link = resolveLink(node, feedUrl);

  const guidEl = direct(node, 'guid')[0] ?? direct(node, 'id')[0];
  const rawId = guidEl ? textOf(guidEl).trim() : '';
  const isPermaLink = (getAttr(guidEl, 'ispermalink') ?? 'true').toLowerCase() !== 'false';
  const id = rawId || getAttr(node, 'about') || link || null;

  // HTML-bearing fields are read raw so entities are decoded exactly once:
  // `htmlToText` decodes while stripping, and the exported markup decodes here.
  const fullRaw = firstRaw(node, 'encoded', CONTENT_NS)
    || firstRaw(node, 'full', CONTENT_NS)
    || firstRaw(node, 'content', ATOM_NS)
    || (direct(node, 'content', MEDIA_NS).length ? '' : firstRaw(node, 'content'));

  const summaryRaw = firstRaw(node, 'description')
    || firstRaw(node, 'summary')
    || mediaAwareRaw(node, 'description')
    || firstRaw(node, 'summary', DC)
    || firstRaw(node, 'abstract', DC)
    || firstRaw(node, 'tagline');

  const contentHtml = decodeEntities(fullRaw.trim());
  const summaryHtml = decodeEntities(summaryRaw.trim());

  const contentText = htmlToText(fullRaw || summaryRaw);
  const summaryText = htmlToText(summaryRaw || fullRaw);

  const categories = [
    ...direct(node, 'category').flatMap((c) => {
      const term = getAttr(c, 'term');
      const label = getAttr(c, 'label');
      const text = textOf(c).trim();
      return splitList(term && !text ? term : (text || term || label || ''));
    }),
    ...splitList(firstText(node, 'subject', DC)),
    ...splitList(firstText(node, 'keywords', ITUNES_NS)),
    ...splitList(firstText(node, 'keywords')),
  ];

  const authorName = mediaAwareText(node, 'creator', DC)
    || mediaAwareText(node, 'author', ITUNES_NS)
    || (direct(node, 'author')[0]
      ? (firstText(direct(node, 'author')[0], 'name') || textOf(direct(node, 'author')[0]).trim())
      : '');
  const authorEmail = direct(node, 'author')[0] ? firstText(direct(node, 'author')[0], 'email') : '';
  const author = parseAuthor(authorEmail ? `${authorName} (${authorEmail})` : authorName);

  const dateRaw = firstText(node, 'pubDate')
    || firstText(node, 'published')
    || firstText(node, 'date', DC)
    || firstText(node, 'issued', DC)
    || firstText(node, 'updated')
    || firstText(node, 'modified', DCTERMS)
    || mediaAwareText(node, 'publication_date')
    || '';

  const images = collectImages(node);
  const enclosures = collectEnclosures(node);
  const audio = enclosures.find((e) => (e.mimeType ?? '').startsWith('audio/'))?.url ?? null;

  const item = {
    type: 'feed_item',
    feedUrl,
    feedTitle: feedTitle ?? null,
    index,
    id,
    title: title || '(untitled)',
    link: link ?? (rawId && isPermaLink ? absoluteUrl(feedUrl, rawId) : null),
    author: author?.name ?? author?.raw ?? null,
    authorEmail: author?.email ?? null,
    categories: [...new Set(categories)],
    pubDate: toDate(dateRaw),
    pubDateRaw: dateRaw || null,
    summary: summaryText || null,
    contentSnippet: snippet(contentText || summaryText),
    image: images[0]?.url ?? inlineImage(fullRaw || summaryRaw, feedUrl),
    images: images.length > 1 ? images.map((i) => i.url) : undefined,
    audio,
    enclosures: enclosures.length ? enclosures : undefined,
    language: firstText(node, 'language', DC) || null,
    scrapedAt: new Date().toISOString(),
  };

  if (includeContent) {
    item.content = contentHtml || summaryHtml || null;
    item.contentText = contentText || null;
  }

  for (const [key, value] of Object.entries(item)) {
    if (value === undefined) delete item[key];
  }
  return item;
}

/* ------------------------------------------------------------- feed mapping */

function mapFeedMeta(root, format, feedUrl) {
  const channel = direct(root, 'channel')[0] ?? root;
  const title = firstText(channel, 'title') || firstText(root, 'title') || null;
  // Same rel-ranking as items: Atom feeds list `rel="self"` before `alternate`.
  const link = resolveLink(channel, feedUrl) ?? resolveLink(root, feedUrl);

  return {
    format,
    url: feedUrl,
    title: title ? decodeEntities(title).trim() : null,
    description: htmlToText(
      firstRaw(channel, 'description')
      || firstRaw(channel, 'tagline')
      || firstRaw(channel, 'subtitle')
      || firstRaw(channel, 'abstract', DC)
      || '',
    ) || null,
    link: link ?? null,
    language: firstText(channel, 'language') || firstText(channel, 'language', DC) || null,
    generator: firstText(channel, 'generator') || null,
    copyright: firstText(channel, 'rights') || firstText(channel, 'copyright') || firstText(channel, 'rights', DC) || null,
    lastBuildDate: toDate(
      firstText(channel, 'lastBuildDate') || firstText(channel, 'updated') || firstText(channel, 'date', DC) || '',
    ),
    image: collectImages(channel)[0]?.url ?? collectImages(root)[0]?.url ?? null,
  };
}

function itemNodes(root, format) {
  if (format === 'atom') return direct(root, 'entry');
  if (format === 'rss1') {
    const nested = direct(direct(root, 'channel')[0] ?? root, 'item');
    const flat = descendants(root, 'item');
    const seen = new Set();
    return [...nested, ...flat].filter((n) => !seen.has(n) && seen.add(n));
  }
  const channel = direct(root, 'channel')[0];
  const nested = channel ? direct(channel, 'item') : [];
  return nested.length ? nested : descendants(root, 'item');
}

function detectFormat(root) {
  switch (root.local?.toLowerCase()) {
    case 'rss': return 'rss2';
    case 'feed': return 'atom';
    case 'rdf':
    case 'rdf:rdf': return 'rss1';
    default: break;
  }
  if (direct(root, 'channel').length && direct(root, 'item').length) return 'rss2';
  if (direct(root, 'entry').length) return 'atom';
  if (direct(root, 'item').length) return 'rss2';
  return 'unknown';
}

/* --------------------------------------------------------------- JSON Feed */

function mapJsonFeed(doc, feedUrl, includeContent) {
  const feed = {
    format: 'json-feed',
    url: feedUrl,
    title: doc.title ?? null,
    description: doc.description ?? null,
    link: absoluteUrl(feedUrl, doc.home_page_url ?? null),
    language: null,
    generator: null,
    copyright: null,
    lastBuildDate: toDate(doc.expire_date ?? ''),
    image: doc.banner_image ?? doc.icon ?? null,
  };

  const items = (Array.isArray(doc.items) ? doc.items : []).map((raw, i) => {
    const html = raw.content_html ?? '';
    const text = raw.content_text ?? '';
    const summary = html ? htmlToText(html) : text;
    const author = Array.isArray(raw.authors)
      ? raw.authors.map((a) => a?.name).filter(Boolean).join(', ')
      : raw.author?.name ?? null;
    const item = {
      type: 'feed_item',
      feedUrl,
      feedTitle: feed.title,
      index: i + 1,
      id: raw.id ?? raw.url ?? null,
      title: raw.title ?? '(untitled)',
      link: absoluteUrl(feedUrl, raw.url ?? raw.external_url ?? null),
      author: author || null,
      authorEmail: null,
      categories: [...new Set((raw.tags ?? []).filter(Boolean).map(String))],
      pubDate: toDate(raw.date_published ?? raw.date_modified ?? ''),
      pubDateRaw: raw.date_published ?? raw.date_modified ?? null,
      summary: summary || null,
      contentSnippet: snippet(summary || ''),
      image: raw.image ?? raw.banner_image ?? feed.image ?? null,
      audio: (raw.attachments ?? []).find((a) => (a?.mime_type ?? '').startsWith('audio/'))?.url ?? null,
      enclosures: (raw.attachments ?? []).filter((a) => a?.url).map((a) => ({
        url: a.url, mimeType: a.mime_type ?? null, lengthBytes: a.size_in_bytes ?? null, source: 'jsonfeed:attachment',
      })),
      language: null,
      scrapedAt: new Date().toISOString(),
    };
    if (raw.external_url) item.externalUrl = absoluteUrl(feedUrl, raw.external_url);
    if (includeContent) {
      item.content = html || text || null;
      item.contentText = text || summary || null;
    }
    return item;
  });

  return { feed, items };
}

/* ------------------------------------------------------------------- public */

/**
 * Parses a feed document of any supported flavour.
 *
 * @param {string} body raw response text (XML or JSON)
 * @param {string} feedUrl used to resolve relative links and label results
 * @param {{maxItemsPerFeed?: number, includeContent?: boolean, removeDuplicates?: boolean}} [options]
 * @returns {{feed: Object, items: Object[], format: string, warnings: string[]}}
 */
export function parseFeed(body, feedUrl, options = {}) {
  const {
    maxItemsPerFeed = LIMITS.defaultItemsPerFeed,
    includeContent = true,
    removeDuplicates = false,
  } = options;

  const text = String(body ?? '').trim();
  if (!text) throw parseError('Feed document is empty');
  if (text.length > LIMITS.maxBytes) throw parseError(`Feed document exceeds ${Math.round(LIMITS.maxBytes / 1048576)} MB`);

  const warnings = [];
  let feed;
  let items;

  if (text[0] === '{') {
    let doc;
    try {
      doc = JSON.parse(text);
    } catch (err) {
      throw parseError(`Response looks like JSON but failed to parse: ${err.message}`);
    }
    if (!doc.version && !Array.isArray(doc.items)) throw parseError('JSON response has no `items` array (not a JSON Feed)');
    ({ feed, items } = mapJsonFeed(doc, feedUrl, includeContent));
  } else {
    const root = parseXml(text);
    const format = detectFormat(root);
    if (format === 'unknown') {
      throw parseError(`Unrecognised document root <${root.name || '?'}>: not RSS, Atom or RDF`);
    }
    feed = mapFeedMeta(root, format, feedUrl);
    items = itemNodes(root, format).map((node, i) => mapItem(node, {
      feedUrl,
      feedTitle: feed.title,
      includeContent,
      index: i + 1,
    }));
  }

  if (!items.length) warnings.push('No items found in this feed');

  const cap = Math.min(Math.max(Number(maxItemsPerFeed) || LIMITS.defaultItemsPerFeed, LIMITS.minItemsPerFeed), LIMITS.maxItemsPerFeed);
  if (items.length > cap) {
    warnings.push(`Truncated from ${items.length} to ${cap} items (maxItemsPerFeed)`);
    items = items.slice(0, cap);
  }

  if (removeDuplicates) {
    const before = items.length;
    const seen = new Set();
    items = items.filter((item) => {
      const key = item.id || item.link || `${item.title}|${item.pubDate}`;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (before !== items.length) warnings.push(`Removed ${before - items.length} duplicate items`);
  }

  items.forEach((item, i) => { item.index = i + 1; });

  return { feed, items, format: feed.format, warnings };
}
