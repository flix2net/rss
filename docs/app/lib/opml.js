/*
 * OPML import / export.
 *
 * Browser-safe: imports only ./xml.js, so tools/build-site.js ships it to the
 * hosted app and the build fails if a Node built-in is ever added here.
 */

import { parseXml, childrenOf, getAttr } from './xml.js';

const OUTLINE = 'outline';

/** Cheap sniff so a pasted blob can be routed to the OPML reader, not the feed parser. */
export function looksLikeOpml(text) {
  const head = String(text ?? '').slice(0, 4096);
  return /<opml[\s>]/i.test(head) || /<outline\b[^>]*xmlUrl/i.test(head);
}

function attr(el, ...names) {
  for (const name of names) {
    const value = getAttr(el, name);
    if (value !== undefined && value !== '') return value;
  }
  return '';
}

function labelOf(el) {
  // OPML readers disagree on which attribute wins; this is the common precedence.
  return attr(el, 'text', 'title', 'label') || attr(el, 'xmlUrl').replace(/^https?:\/\//, '');
}

/**
 * Walks the outline tree, accumulating folder names from every ancestor that is
 * not itself a feed. Returns feeds in document order.
 *
 * @param {string} source OPML document text
 * @returns {{feeds: Array<Object>, folders: string[], warnings: string[]}}
 */
export function parseOpml(source) {
  const warnings = [];
  const root = parseXml(source);
  const opml = root.local === 'opml' ? root : childrenOf(root, 'opml')[0] ?? root;
  const body = childrenOf(opml, 'body')[0];

  if (!body) {
    warnings.push('No <body> element — not an OPML file?');
    return { feeds: [], folders: [], warnings };
  }

  const feeds = [];
  const folders = new Set();
  let skipped = 0;

  const walk = (node, trail) => {
    for (const outline of childrenOf(node, OUTLINE)) {
      const label = labelOf(outline);
      const xmlUrl = attr(outline, 'xmlUrl', 'xmlurl', 'url');

      if (xmlUrl) {
        const folder = trail.join('/');
        if (folder) folders.add(folder);
        feeds.push({
          title: label || xmlUrl,
          url: xmlUrl,
          // `htmlUrl` is the site the feed belongs to, not the feed itself.
          siteUrl: attr(outline, 'htmlUrl', 'htmlurl') || null,
          folder: folder || null,
          type: attr(outline, 'type') || null,
          added: attr(outline, 'created', 'dateCreated') || null,
        });
      } else if (childrenOf(outline, OUTLINE).length) {
        walk(outline, label ? [...trail, label] : trail);
      } else {
        skipped += 1;
      }
    }
  };

  walk(body, []);
  if (skipped) warnings.push(`${skipped} outline(s) had no xmlUrl and no children — ignored`);
  if (!feeds.length) warnings.push('OPML contained no feeds');

  return { feeds, folders: [...folders], warnings };
}

function escapeAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Serialises feeds back to OPML 2.0, grouping by `folder` ("A/B" nests).
 * @param {Array<{title:string,url:string,siteUrl?:string|null,folder?:string|null}>} feeds
 * @param {{title?: string}} [meta]
 */
export function toOpml(feeds, meta = {}) {
  const title = meta.title || 'rss-feed-extractor subscription list';
  const tree = new Map();

  for (const feed of feeds) {
    const parts = String(feed.folder ?? '').split('/').map((s) => s.trim()).filter(Boolean);
    let level = tree;
    for (const part of parts) {
      if (!level.has(part)) level.set(part, new Map());
      level = level.get(part);
    }
    if (!level.__feeds) level.__feeds = [];
    level.__feeds.push(feed);
  }

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="2.0">',
    '  <head>',
    `    <title>${escapeAttr(title)}</title>`,
    `    <dateCreated>${new Date().toUTCString()}</dateCreated>`,
    '    <ownerName>rss-feed-extractor</ownerName>',
    '  </head>',
    '  <body>',
  ];

  const emit = (level, depth) => {
    const pad = ' '.repeat(depth * 2 + 4);
    // Folder outlines first, then the feeds hanging directly off this level.
    for (const [name, child] of level) {
      lines.push(`${pad}<outline text="${escapeAttr(name)}" title="${escapeAttr(name)}">`);
      emit(child, depth + 1);
      lines.push(`${pad}</outline>`);
    }
    for (const feed of level.__feeds ?? []) {
      const attrs = [`text="${escapeAttr(feed.title)}"`, `title="${escapeAttr(feed.title)}"`,
        `type="rss"`, `xmlUrl="${escapeAttr(feed.url)}"`];
      if (feed.siteUrl) attrs.push(`htmlUrl="${escapeAttr(feed.siteUrl)}"`);
      lines.push(`${pad}<outline ${attrs.join(' ')}/>`);
    }
  };

  emit(tree, 1);
  lines.push('  </body>', '</opml>', '');
  return lines.join('\n');
}

/**
 * Feeds whose title was synthesised from the URL rather than declared in the
 * file, so callers can warn that the export will look like a list of hosts.
 */
export function untitledFeeds(feeds) {
  return feeds.filter((feed) => {
    if (!feed.title) return true;
    const stripped = String(feed.url ?? '').replace(/^https?:\/\//, '');
    return feed.title === feed.url || feed.title === stripped;
  });
}
