# rss-feed-extractor

A **free, local, zero-dependency** RSS / Atom / JSON Feed extractor with a web GUI.

Project page: **<https://flix2net.github.io/rss/>**

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/flix2net/rss?quickstart=1)

It does the job of hosted feed-scraping actors (you paste feed URLs, you get clean structured items back)
without an account, an API key, a run quota, or your URLs being sent through anyone else's servers.

```
npm install        ← nothing to install
node src/cli.js    ← open http://127.0.0.1:5055 and you're running
```

On Windows you can just **double-click `start.bat`**.

<!-- ![rss-feed-extractor GUI](docs/screenshot.png)  ← uncomment once docs/screenshot.png exists -->

### Use it from a browser

**<https://flix2net.github.io/rss/app/>** — the same GUI, served by GitHub Pages, opens on a phone or
a library computer with nothing installed.

It needs one thing you must supply: a **relay**. No real feed sends `Access-Control-Allow-Origin`
(checked against BBC, HN, The Verge, GitHub Atom and Google News), so a browser cannot read one
directly and Pages runs no server. Deploy [`worker/relay.js`](worker/relay.js) to Cloudflare Workers —
free tier, 100k requests/day, no card, paste-into-the-editor to deploy — then paste its URL into the
Relay field. It is remembered in `localStorage`, so it is a one-time setup per browser.

The relay only moves bytes; parsing still happens in your tab with the same `src/feed.js` the CLI
uses. Your feed URLs go to a Worker you own, not to a third-party service.

Still prefer a full local run? The Codespaces badge above starts the real server instead: it runs the
67 tests, serves port 5055 and forwards it privately. Handy for a trial, but a Codespace burns
core-hours while idle, so stop it when you are done (`gh codespace stop -a`).

---

## Why

Hosted feed extractors are billed per result or per compute unit. The actual work — an HTTP GET and an
XML parse — costs nothing, so this tool does it on your own machine:

| | Hosted actor | this tool |
|---|---|---|
| Cost | subscription / credits | free, MIT |
| Setup | account + API token | Node.js, no `npm install` |
| Privacy | feed list visible to a third party | stays on localhost |
| Item ceiling | plan-dependent | 500 per feed, yours to change |
| Runs offline | no | yes (feeds themselves need network) |
| Install size | — | ~100 KB, **zero dependencies** |

## Requirements

Node.js **18.17+** (developed and tested on Node 22). Nothing else — no packages, no build step,
no native modules. Every feature uses Node built-ins (`node:http`, `node:fs`, global `fetch`).

## Usage

### GUI

```bash
node src/cli.js                 # start the server and open a browser
node src/cli.js --port 8080     # pick a port (auto-increments if busy)
node src/cli.js --no-open       # don't launch a browser
node src/cli.js --host 0.0.0.0  # expose on your LAN (see Security)
```

Paste feed URLs (one per line), set **Max items per feed**, press **Start** (`Ctrl+Enter` works too).
Then filter, sort, read full text inline, and export. Your input is remembered in `localStorage`.

### Headless / scripts

```bash
node src/cli.js extract https://feeds.bbci.co.uk/news/rss.xml --max 10
node src/cli.js extract feeds.txt --format csv --out news.csv      # feeds.txt: one URL per line
node src/cli.js extract https://x.example/feed --format ndjson | jq -r .title
node src/cli.js extract a.xml b.xml c.xml --no-content --errors    # omit bodies, log failures
```

Exit code is `1` if every feed failed, `2` for bad arguments — safe to use in CI.

## Input options

Mirrors the actor's input schema, plus a few extras that only make sense locally.

| Field | Type | Default | Notes |
|---|---|---|---|
| `feedUrls` | string[] | — | **Required.** RSS 2.0, Atom 1.0, RSS 1.0 (RDF) or JSON Feed 1.0/1.1. Bare hosts get `https://`. Duplicates are collapsed. |
| `maxItemsPerFeed` | number | `50` | Clamped to 1–500. |
| `includeContent` | boolean | `true` | `false` drops `content` / `contentText`, keeping `summary` and `contentSnippet`. Much smaller payloads. |
| `removeDuplicates` | boolean | `false` | Collapses repeated items by `id`, then `link`, then `title`+`pubDate`. |
| `concurrency` | number | `5` | Feeds fetched at once (1–20). |
| `timeoutMs` | number | `20000` | Per-feed wall clock. |
| `allowPrivate` | boolean | `false` | Must be `true` to fetch loopback / RFC1918 hosts. |

## Output shape

`items[]` is flat across all feeds, so it drops straight into a spreadsheet or a `jq` pipeline.

```jsonc
{
  "items": [
    {
      "type": "feed_item",
      "feedUrl": "https://www.theverge.com/rss/index.xml",
      "feedTitle": "The Verge",
      "index": 1,
      "id": "https://www.theverge.com/?p=987756",
      "title": "The robot butler dream doesn't have legs",
      "link": "https://www.theverge.com/tech/987756/...",
      "author": "Jennifer Pattison Tuohy",
      "authorEmail": null,
      "categories": ["Analysis", "IFA 2026", "Tech"],
      "pubDate": "2026-09-02T11:00:00.000Z",   // normalised ISO-8601, or null
      "pubDateRaw": "2026-09-02T07:00:00-04:00",
      "summary": "The idea of humanoid robots running our homes...",
      "contentSnippet": "LG's CLOiD is a robot housekeeper on wheels...",
      "image": "https://platform.theverge.com/wp-content/uploads/...jpg",
      "audio": null,                            // first audio/* enclosure
      "enclosures": [{ "url": "...", "mimeType": "audio/mpeg", "lengthBytes": 123 }],
      "language": null,
      "scrapedAt": "2026-09-02T11:41:48.538Z",
      "content": "<figure>...",                 // markup, only when includeContent
      "contentText": "LG's CLOiD is a robot..." // markup stripped
    }
  ],
  "errors": [
    { "type": "error", "feedUrl": "https://x.example/feed", "error": "HTTP 404 Not Found",
      "code": "http_status", "status": 404 }
  ],
  "feeds": [
    { "feedUrl": "...", "ok": true, "items": 4, "bytes": 25695, "elapsedMs": 1247,
      "feed": { "format": "rss2", "title": "BBC News", "link": "...", "image": "..." },
      "warnings": ["Truncated from 33 to 4 items (maxItemsPerFeed)"] }
  ],
  "stats": { "requested": 2, "succeeded": 2, "failed": 0, "totalItems": 8,
             "totalBytes": 111688, "durationMs": 328 }
}
```

A failed feed never aborts the batch — it lands in `errors` with a machine-readable `code`
(`timeout`, `network_error`, `http_status`, `blocked_host`, `too_large`, `empty_body`,
`invalid_url`, `parse_failed`).

## What it handles

The parsing layer is the actual substance of this project, so it is deliberately forgiving — real feeds
are malformed far more often than spec-compliant.

- **Formats:** RSS 2.0, Atom 1.0, RSS 1.0 / RDF, JSON Feed 1.0 & 1.1
- **Namespaces:** `content:encoded`, `dc:*`, `dcterms:*`, `media:content` / `media:thumbnail` /
  `media:group` (YouTube, Vimeo), `itunes:*`, `webfeeds:favicon`, `slash:*`, `georss:*` — resolved by
  URI, with a well-known-prefix fallback for feeds that forget to declare them
- **Encodings:** honours HTTP `charset` and the XML declaration, maps `iso-8859-1` → `windows-1252`
  per the WHATWG spec, and handles BOMs, gzip/deflate/br (via `fetch`) and redirects
- **Dates:** RFC 822, ISO 8601 with and without a zone, two-digit years, and Unix timestamps in
  seconds or milliseconds
- **Links:** Atom `rel` ranking (`alternate` > implicit > `related`, never `self`/`edit`/`hub`),
  relative URLs resolved against the feed, `<guid isPermaLink="true">` used when `<link>` is absent
- **Images:** Media RSS → `<image>` → `itunes:image` → image enclosures → `<img>` inside the content
  HTML (with `data-src` lazy-load fallbacks), largest-first
- **Broken markup:** unclosed leaf tags are implicitly closed, entities missing their semicolon are
  repaired, stray close tags are ignored, `script`/`style` bodies are dropped rather than leaked as
  text, and unknown-size documents are capped instead of hanging

## Architecture

```
src/
  xml.js      tokenizer + tree builder: namespaces, CDATA, DOCTYPE, entity repair, recovery
  feed.js     format mapping to one flat item record; dates, HTML→text, media, links
  fetcher.js  HTTP, charset detection, byte ceiling, timeouts, private-host guard, mapLimit
  extract.js  input validation, bounded concurrency, per-feed error capture
  server.js   localhost HTTP server + JSON API
  export.js   JSON / CSV / NDJSON / Markdown serialisation
  cli.js      argument parsing, serve and extract modes
public/
  index.html  the GUI (inline CSS + JS, no bundler, no CDN)
worker/
  relay.js    optional Cloudflare Worker that adds CORS for the hosted build
tools/
  build-site.js  regenerates docs/app/ (the hosted GUI + its parser copy)
test/         67 tests on node:test — parser, formats, fetcher, HTTP surface, relay, build
```

## Security

- Binds `127.0.0.1` only. `--host 0.0.0.0` exposes it to your network; the tool has **no
  authentication**, so only do that on a trusted LAN.
- `POST /api/extract` requires an `x-rss-extractor` header. That forces a CORS preflight no
  third-party site can pass, so a random webpage cannot get this server to fetch URLs for it.
- Loopback, RFC1918, CGNAT and link-local (including `169.254.169.254`) targets are refused unless
  you opt in with `allowPrivate` — this is what stops the server being turned into an SSRF probe.
- Feed HTML is never injected into the DOM: the GUI renders every field through `textContent`, and a
  Content-Security-Policy blocks remote scripts.
- CSV export prefixes cells starting with `= + - @` so Excel will not evaluate them as formulas.
- No telemetry, no update checks, no network calls except the feeds you name.
- The hosted build's relay is opt-in and yours: `worker/relay.js` refuses non-http(s) schemes and
  every loopback, RFC1918, CGNAT and link-local target, using the same rules as the local server
  (asserted by a parity test, so the two cannot drift apart). It caps responses at 8 MB. Set
  `ALLOWED_ORIGINS` in that file to lock it to your own page — an open relay is an SSRF door.

## Limits

500 items per feed · 200 feeds per request · 12 MB per feed document · 20s default timeout ·
1 MB request body. All are single constants in `LIMITS` (`src/feed.js`) — edit and restart.

## Development

```bash
node --test              # 67 tests, no framework to install
node tools/build-site.js # regenerate docs/app/ after editing src/ or public/
```

`docs/app/` is committed on purpose: Pages deploys the branch directly, so no CI workflow file is
needed. A test asserts the copied parser is byte-identical to `src/`, so forgetting the rebuild fails
`node --test` rather than shipping a stale hosted app.

Tests cover the parser against hand-written malformed fixtures, plus a real HTTP round-trip against a
local fixture server (charset decoding, gzip, 404s, timeouts, the CSRF guard, path traversal).

## Troubleshooting

| Symptom | Cause |
|---|---|
| `Refusing to fetch private/internal host` | The feed is on `localhost`/your LAN. Tick **Allow private** (or pass `--allow-private`). |
| `HTTP 403` from the feed | The publisher blocks non-browser agents. Point `--host` at a real browser UA by editing `DEFAULT_USER_AGENT` in `src/fetcher.js`. |
| `Unrecognised document root <html>` | That URL is a web page, not a feed. Find the `<link rel="alternate" type="application/rss+xml">` inside it. |
| `Timed out after 20000 ms` | Slow publisher or a big feed — raise **Timeout**. |
| Every item has `link: null` | Some podcast feeds genuinely omit `<link>`; the audio is in `enclosures`/`audio`. |
| Garbled accents (Ã©) | The feed declares no charset. Add the right label to `ENCODING_ALIASES` in `src/fetcher.js`. |
| Port busy | The server walks upward from 5055 automatically; check the printed URL. |

## Contributing

Fork it, branch off `main`, add a fixture to `test/feed.test.js` for any parsing behaviour you change,
and open a PR. `node --test` must pass.

## License

MIT — see [LICENSE](LICENSE).
