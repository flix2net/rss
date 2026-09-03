/**
 * Minimal, dependency-free XML reader tuned for real-world syndication feeds.
 *
 * Feeds are frequently malformed (unclosed tags, entities without semicolons,
 * undeclared namespace prefixes, stray HTML). A strict parser rejects most of
 * them, so this one is deliberately forgiving: it recovers instead of throwing.
 */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', bull: '\u2022',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', middot: '\u00b7', deg: '\u00b0',
  plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7', frac12: '\u00bd',
  sup2: '\u00b2', sup3: '\u00b3', micro: '\u00b5', para: '\u00b6', sect: '\u00a7',
  euro: '\u20ac', pound: '\u00a3', yen: '\u00a5', curren: '\u00a4',
  iexcl: '\u00a1', iquest: '\u00bf', szlig: '\u00df',
  agrave: '\u00e0', aacute: '\u00e1', acirc: '\u00e2', auml: '\u00e4',
  eacute: '\u00e9', egrave: '\u00e8', ecirc: '\u00ea', euml: '\u00eb',
  igrave: '\u00ec', iacute: '\u00ed', icirc: '\u00ee', iuml: '\u00ef',
  ntilde: '\u00f1', oacute: '\u00f3', ocirc: '\u00f4', ouml: '\u00f6',
  uacute: '\u00fa', ucirc: '\u00fb', uuml: '\u00fc', ccedil: '\u00e7',
};

/** Prefixes feeds use without declaring them; assumed when the URI is missing. */
export const WELL_KNOWN_NAMESPACES = {
  content: 'http://purl.org/rss/1.0/modules/content/',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  media: 'http://search.yahoo.com/mrss/',
  mrss: 'http://search.yahoo.com/mrss/',
  itunes: 'http://www.itunes.com/dtds/podcast-1.0.dtd',
  atom: 'http://www.w3.org/2005/Atom',
  slash: 'http://purl.org/rss/1.0/modules/slash/',
  sy: 'http://purl.org/rss/1.0/modules/syndication/',
  admin: 'http://webns.net/mvcb/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  georss: 'http://www.georss.org/georss',
  gd: 'http://www.w3.org/2003/01/geo/wgs84_pos#',
  thr: 'http://purl.org/syndication/thread/1.0',
  webfeeds: 'http://webfeeds.org/rss/1.0',
  google: 'http://www.google.com/schemas/sitemap/0.84',
  xhtml: 'http://www.w3.org/1999/xhtml',
};

const XML_NS = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_URI = 'http://www.w3.org/2000/xmlns/';

const MAX_NODES = 300_000;
const MAX_DEPTH = 200;

/**
 * Decodes entities, tolerating the missing-semicolon forms common in feeds.
 * @param {string} input
 * @returns {string}
 */
export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input;
  return input.replace(
    /&#x[0-9a-fA-F]{1,6};?|&#\d{1,7};?|&[a-zA-Z][a-zA-Z0-9._-]*;?/g,
    (match) => {
      const body = match.slice(1, match.endsWith(';') ? -1 : undefined);
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return codePoint(parseInt(body.slice(2), 16), match);
      }
      if (body.startsWith('#')) {
        return codePoint(parseInt(body.slice(1), 10), match);
      }
      const named = NAMED_ENTITIES[body];
      if (named !== undefined) return named;
      // Tolerate `&AMP;`-style casing, but leave genuine unknowns untouched so
      // that things like `&follow` inside a URL survive round-tripping.
      const lowered = body.toLowerCase();
      return NAMED_ENTITIES[lowered] ?? match;
    },
  );
}

function codePoint(value, fallback) {
  if (!Number.isFinite(value) || value < 0 || value > 0x10fffd) return fallback;
  try {
    return String.fromCodePoint(value);
  } catch {
    return fallback;
  }
}

function element(name, local, prefix, uri, attrs, parent) {
  return { type: 'element', name, local, prefix, uri, attrs, children: [], parent };
}

function pushText(node, value) {
  if (!value) return;
  const last = node.children[node.children.length - 1];
  if (last && last.type === 'text') last.value += value;
  else node.children.push({ type: 'text', value });
}

const WHITESPACE_ONLY = /^\s*$/;

/**
 * Elements that only ever hold text. When one is left open and the next feed
 * field starts, real-world parsers implicitly close it — without this, a single
 * `<title>Foo<guid>x</guid>` corrupts the rest of the item.
 */
const TEXT_LEAF_ELEMENTS = new Set([
  'title', 'link', 'guid', 'id', 'pubdate', 'published', 'updated', 'created',
  'issued', 'modified', 'creator', 'contributor', 'language', 'lastbuilddate',
  'tagline', 'subtitle', 'rights', 'summary', 'description', 'abstract',
  'generator', 'docs', 'managingeditor', 'webmaster', 'name', 'email', 'url',
]);

/** Names that mark "a sibling field is starting", so implicit close is safe. */
const SIBLING_FIELD_NAMES = new Set([
  ...TEXT_LEAF_ELEMENTS,
  'category', 'enclosure', 'author', 'content', 'item', 'entry', 'channel',
  'image', 'source', 'comments', 'ttl', 'guid', 'toplevel',
]);

function isNameStart(ch) {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === ':' || ch > '\u007f';
}

/**
 * Skips a `<!` declaration (DOCTYPE, ENTITY, notation), honouring the
 * bracketed internal subset so that `>` inside `[...]` does not end it early.
 */
function skipDeclaration(src, start) {
  let i = start + 2;
  let bracketDepth = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (ch === '>' && bracketDepth === 0) return i + 1;
    else if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < src.length && src[i] !== quote) i++;
    }
    i++;
  }
  return src.length;
}

/**
 * Reads an element's name and attributes starting at the `<`.
 * @returns {{name: string, attrs: Object<string,string>, selfClosing: boolean, end: number}|null}
 */
function readTag(src, start) {
  const len = src.length;
  let i = start + 1;
  const nameStart = i;
  while (i < len && !/[\s/>]/.test(src[i])) i++;
  const name = src.slice(nameStart, i);
  if (!name || !isNameStart(name[0])) return null;

  const attrs = Object.create(null);
  let selfClosing = false;

  for (;;) {
    while (i < len && /\s/.test(src[i])) i++;
    if (i >= len) break;
    const ch = src[i];
    if (ch === '>') { i++; break; }
    if (ch === '/' && src[i + 1] === '>') { selfClosing = true; i += 2; break; }

    const attrStart = i;
    while (i < len && !/[\s=/>]/.test(src[i])) i++;
    const attrName = src.slice(attrStart, i);
    if (!attrName) { i++; continue; }

    let j = i;
    while (j < len && /\s/.test(src[j])) j++;
    if (src[j] !== '=') {
      // Valueless attribute (HTML-ism); record it as its own name.
      attrs[attrName.toLowerCase()] = attrName.toLowerCase();
      continue;
    }
    j++;
    while (j < len && /\s/.test(src[j])) j++;

    let value;
    const quote = src[j];
    if (quote === '"' || quote === "'") {
      const close = src.indexOf(quote, j + 1);
      value = src.slice(j + 1, close === -1 ? len : close);
      i = close === -1 ? len : close + 1;
    } else {
      const valueStart = j;
      while (j < len && !/[\s>]/.test(src[j])) j++;
      value = src.slice(valueStart, j);
      i = j;
    }
    attrs[attrName.toLowerCase()] = decodeEntities(value);
    // Namespaced attributes (`rdf:about`, `media:url`) are almost always wanted
    // by their local name, so index that alias too.
    const colon = attrName.indexOf(':');
    if (colon > 0 && !attrName.toLowerCase().startsWith('xmlns:')) {
      attrs[attrName.slice(colon + 1).toLowerCase()] = decodeEntities(value);
    }
  }

  return { name, attrs, selfClosing, end: i };
}

/**
 * Parses XML into a light element tree. Never throws on malformed input.
 * @param {string} source
 * @returns {Object} the document root element (or a synthetic `#root`)
 */
export function parseXml(source) {
  let src = typeof source === 'string' ? source : String(source ?? '');
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);

  const doc = element('#document', '#document', null, null, Object.create(null), null);
  /** @type {{el: Object, scopes: Array<Object<string,string>>}[]} */
  const stack = [{ el: doc, scopes: [] }];
  let nodes = 0;
  let i = 0;
  const len = src.length;

  const current = () => stack[stack.length - 1];
  const resolveNs = (prefix) => {
    for (let s = stack.length - 1; s >= 0; s--) {
      for (let k = stack[s].scopes.length - 1; k >= 0; k--) {
        const uri = stack[s].scopes[k][prefix];
        if (uri !== undefined) return uri;
      }
    }
    return prefix && WELL_KNOWN_NAMESPACES[prefix.toLowerCase()]
      ? WELL_KNOWN_NAMESPACES[prefix.toLowerCase()]
      : null;
  };

  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      pushText(current().el, src.slice(i));
      break;
    }
    if (lt > i) pushText(current().el, src.slice(i, lt));
    i = lt;

    if (src.startsWith('<!--', i)) {
      const end = src.indexOf('-->', i + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<![CDATA[', i)) {
      const end = src.indexOf(']]>', i + 9);
      const body = src.slice(i + 9, end === -1 ? len : end);
      const owner = current().el;
      if (body) owner.children.push({ type: 'cdata', value: body });
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (src.startsWith('<?', i)) {
      const end = src.indexOf('?>', i + 2);
      i = end === -1 ? len : end + 2;
      continue;
    }
    if (src.startsWith('<!', i)) {
      i = skipDeclaration(src, i);
      continue;
    }
    if (src.startsWith('</', i)) {
      const end = src.indexOf('>', i + 2);
      const raw = src.slice(i + 2, end === -1 ? len : end).trim();
      i = end === -1 ? len : end + 1;
      if (raw) closeElement(raw);
      continue;
    }

    const tag = readTag(src, i);
    if (!tag) {
      pushText(current().el, '<');
      i += 1;
      continue;
    }
    i = tag.end;

    if (++nodes > MAX_NODES) break;

    const colon = tag.name.indexOf(':');
    const prefix = colon > 0 ? tag.name.slice(0, colon) : null;
    const local = colon > 0 ? tag.name.slice(colon + 1) : tag.name;

    const lowerLocal = local.toLowerCase();
    if (!tag.selfClosing && SIBLING_FIELD_NAMES.has(lowerLocal)) {
      for (let guard = 0; guard < 3 && stack.length > 1; guard++) {
        const openLocal = stack[stack.length - 1].el.local.toLowerCase();
        if (!TEXT_LEAF_ELEMENTS.has(openLocal)) break;
        if (openLocal === lowerLocal && lowerLocal !== 'link') break;
        stack.pop();
      }
    }

    const declared = Object.create(null);
    const attrs = Object.create(null);
    for (const [key, value] of Object.entries(tag.attrs)) {
      if (key === 'xmlns') declared[''] = value;
      else if (key.startsWith('xmlns:')) declared[key.slice(6)] = value;
      else attrs[key] = value;
    }

    const declaredScopes = [];
    for (const [p, nsUri] of Object.entries(declared)) {
      declaredScopes.push({ [p]: nsUri === '' ? null : nsUri });
    }

    let uri = null;
    if (prefix) uri = resolveNs(prefix);
    else if (declaredScopes.length === 0) uri = resolveNs('');

    const parent = current().el;
    if (stack.length > MAX_DEPTH) continue;

    const el = element(tag.name, local, prefix, uri, attrs, parent);
    parent.children.push(el);

    if (tag.selfClosing) continue;
    stack.push({ el, scopes: declaredScopes });
  }

  function closeElement(rawName) {
    const colon = rawName.indexOf(':');
    const local = (colon > 0 ? rawName.slice(colon + 1) : rawName).toLowerCase();
    for (let s = stack.length - 1; s > 0; s--) {
      const el = stack[s].el;
      if (el.local.toLowerCase() === local || el.name.toLowerCase() === rawName.toLowerCase()) {
        stack.length = s;
        return;
      }
    }
    // No matching opener: a stray close tag. Ignore it rather than bail out.
  }

  const root = doc.children.find((c) => c.type === 'element');
  return root ?? doc;
}

/** @param {Object} el @param {string} name @returns {string|undefined} */
export function getAttr(el, name) {
  if (!el?.attrs) return undefined;
  const key = name.toLowerCase();
  return el.attrs[key];
}

/** Direct children matching a local name, optionally constrained by namespace URI. */
export function childrenOf(el, local, uris) {
  if (!el?.children) return [];
  const wanted = uris ? (Array.isArray(uris) ? uris : [uris]) : null;
  return el.children.filter((c) => {
    if (c.type !== 'element') return false;
    if (c.local.toLowerCase() !== local.toLowerCase()) return false;
    if (!wanted) return true;
    return c.uri !== null && c.uri !== undefined ? wanted.includes(c.uri) : wanted.length > 0;
  });
}

/** Children matched by raw qualified name (e.g. `media:thumbnail`) or namespace URI. */
export function childrenByAnyName(el, local, uris) {
  if (!el?.children) return [];
  const wanted = uris ? (Array.isArray(uris) ? uris : [uris]) : null;
  return el.children.filter((c) => {
    if (c.type !== 'element') return false;
    if (c.local.toLowerCase() !== local.toLowerCase()) return false;
    if (!wanted) return true;
    if (c.uri) return wanted.includes(c.uri);
    // Undeclared prefix: fall back to the well-known URI for that prefix.
    return c.prefix ? wanted.includes(WELL_KNOWN_NAMESPACES[c.prefix.toLowerCase()]) : false;
  });
}

/** @returns {Object|undefined} first matching child */
export function firstChild(el, local, uris) {
  return childrenByAnyName(el, local, uris)[0];
}

/**
 * Concatenates all descendant text. Text and CDATA are stored verbatim by the
 * parser (entities are only decoded in attributes), so `raw: true` yields the
 * original markup for fields that legitimately carry HTML.
 */
export function textOf(el, { raw = false } = {}) {
  if (!el) return '';
  const out = [];
  walk(el);
  const joined = out.join('');
  return raw ? joined : decodeEntities(joined);

  function walk(node) {
    for (const child of node.children ?? []) {
      if (child.type === 'text' || child.type === 'cdata') out.push(child.value);
      else if (child.type === 'element') walk(child);
    }
  }
}

/** Same as `textOf(el, { raw: true })` — markup preserved, entities untouched. */
export function rawTextOf(el) {
  return textOf(el, { raw: true });
}

/** True when an element carries no text at all (common for `<x:foo/>` placeholders). */
export function isEmptyText(el) {
  return WHITESPACE_ONLY.test(textOf(el));
}

export { XML_NS };
