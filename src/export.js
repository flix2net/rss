/**
 * Serialises extracted items into the formats the GUI and CLI offer.
 */

const CSV_COLUMNS = [
  'feedTitle', 'feedUrl', 'title', 'link', 'author', 'pubDate',
  'categories', 'summary', 'contentSnippet', 'image', 'audio', 'id',
];

function cell(value) {
  if (value === null || value === undefined) return '';
  const text = Array.isArray(value) ? value.join('|') : String(value);
  // Neutralise spreadsheet formula injection (CSV opened in Excel).
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function toCsv(items, columns = CSV_COLUMNS) {
  const header = columns.map(cell).join(',');
  const rows = items.map((item) => columns.map((c) => cell(item[c])).join(','));
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`;
}

export function toJson(payload, pretty = true) {
  return JSON.stringify(payload, null, pretty ? 2 : 0);
}

export function toMarkdown(items) {
  const groups = new Map();
  for (const item of items) {
    const key = item.feedTitle || item.feedUrl || 'Untitled feed';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const lines = [];
  for (const [feed, list] of groups) {
    lines.push(`## ${feed}`, '');
    for (const item of list) {
      const date = item.pubDate ? item.pubDate.slice(0, 10) : null;
      const heading = item.link ? `[${item.title}](${item.link})` : item.title;
      lines.push(`### ${heading}${date ? ` — ${date}` : ''}`);
      if (item.author) lines.push('', `*${item.author}*`);
      if (item.contentSnippet) lines.push('', item.contentSnippet);
      if (item.categories?.length) {
        lines.push('', item.categories.map((c) => `\`${c}\``).join(' '));
      }
      lines.push('');
    }
  }
  return lines.join('\n').trim();
}

export { CSV_COLUMNS };
