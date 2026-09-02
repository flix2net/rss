import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCsv, toJson, toMarkdown, CSV_COLUMNS } from '../src/export.js';

const items = [
  {
    feedTitle: 'Example', feedUrl: 'https://e.example/f', title: 'Has "quotes", comma',
    link: 'https://e.example/1', author: null, pubDate: '2026-09-02T00:00:00.000Z',
    categories: ['a', 'b'], summary: 'line one\nline two', contentSnippet: 's', image: null, id: '1',
  },
  {
    feedTitle: 'Example', feedUrl: 'https://e.example/f', title: '=cmd()', link: null,
    author: 'Ada', pubDate: null, categories: [], summary: null, contentSnippet: null,
    image: 'https://e.example/i.png', id: '2',
  },
];

test('CSV quotes, escapes and joins arrays', () => {
  const csv = toCsv(items);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], CSV_COLUMNS.map((c) => `"${c}"`).join(','));
  assert.ok(lines[1].includes('"Has ""quotes"", comma"'), 'embedded quotes must be doubled');
  assert.ok(lines[1].includes('"a|b"'), 'arrays collapse to a pipe-joined cell');
  assert.ok(lines[1].includes('"line one\nline two"'), 'newlines stay inside a quoted cell');
});

test('CSV neutralises spreadsheet formula injection', () => {
  const csv = toCsv(items);
  assert.ok(csv.includes('"\'=cmd()"'), 'a leading = must be prefixed so Excel shows it literally');
  assert.ok(csv.startsWith('\uFEFF'), 'BOM keeps Excel on UTF-8');
});

test('JSON export stays parseable', () => {
  assert.equal(JSON.parse(toJson({ items }, false)).items.length, 2);
  assert.match(toJson({ a: 1 }), /"a": 1/);
});

test('Markdown groups by feed and links titles', () => {
  const md = toMarkdown(items);
  assert.equal(md.match(/^## Example$/gm).length, 1);
  assert.ok(md.includes('### [Has "quotes", comma](https://e.example/1) — 2026-09-02'));
  assert.ok(md.includes('### =cmd()'));
  assert.ok(md.includes('*Ada*'));
  assert.ok(md.includes('`a` `b`'), 'categories render as inline code');
});
