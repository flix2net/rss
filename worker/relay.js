/*
 * rss-feed-extractor — CORS relay for the hosted web app.
 *
 * Why this exists: no real-world feed sends `Access-Control-Allow-Origin`
 * (verified against BBC, HN, The Verge, GitHub Atom and Google News), so a page
 * on GitHub Pages cannot fetch one directly. This Worker adds the header.
 *
 * It is a pure transport shim: it fetches the bytes and hands them back. All
 * parsing stays in the browser, in the same xml.js / feed.js the local CLI uses.
 *
 * DEPLOY (no downloads needed):
 *   1. dash.cloudflare.com → Workers & Pages → Create → Worker → "Get started"
 *   2. Replace the editor contents with this whole file → Deploy
 *   3. Copy the printed https://<name>.<subdomain>.workers.dev URL into the
 *      "Relay URL" field of the hosted app.
 *
 * Free tier: 100,000 requests/day, no credit card.
 */

/** Requests are refused above this size, so the relay can't be used to move bulk data. */
const MAX_BYTES = 8 * 1024 * 1024;

/** Set to ['https://flix2net.github.io'] to lock the relay to your own page. Empty = any origin. */
const ALLOWED_ORIGINS = [];

const STATIC_HEADERS = {
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-max-age': '600',
  // Without this the browser hides x-relay-final-url from the page, and the
  // app needs it to resolve relative links after the feed redirected.
  'access-control-expose-headers': 'content-type, x-relay-final-url, x-relay-bytes',
};

const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal']);

/**
 * Mirrors isPrivateHost() in src/fetcher.js so the hosted relay is no more
 * permissive than the local server. Without this the Worker would be an open
 * door into Cloudflare's own internal network (link-local, 169.254.169.254 etc).
 */
export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (PRIVATE_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.internal')) return true;
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!v4) return false;
  const [a, b] = v4.slice(1).map(Number);
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function corsHeaders(origin) {
  const headers = { ...STATIC_HEADERS, vary: 'origin' };
  // Omit rather than send an empty value: a missing header makes the browser
  // block the response cleanly, whereas `access-control-allow-origin: ""` is a
  // malformed value that some clients treat as permissive.
  if (ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS.includes(origin)) {
    headers['access-control-allow-origin'] = origin || '*';
  }
  return headers;
}

function reject(status, message, origin) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders(origin), 'content-type': 'application/json; charset=utf-8' },
  });
}

export default {
  async fetch(request) {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== 'GET') {
      return reject(405, 'Use GET', origin);
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) return reject(400, 'Missing ?url=', origin);

    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(target) ? target : `https://${target}`);
    } catch {
      return reject(400, 'Not a valid URL', origin);
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return reject(400, `Unsupported protocol "${url.protocol}"`, origin);
    }
    if (isPrivateHost(url.hostname)) {
      return reject(403, `Refusing to fetch private/internal host "${url.hostname}"`, origin);
    }

    let upstream;
    try {
      upstream = await fetch(url.href, {
        redirect: 'follow',
        cf: { cacheTtl: 60 },
        headers: {
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
            + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 rss-feed-extractor/1.0',
          accept: 'application/rss+xml, application/atom+xml, application/feed+json, '
            + 'application/xml;q=0.9, text/xml;q=0.8, application/json;q=0.7, */*;q=0.5',
        },
      });
    } catch {
      return reject(502, 'Could not reach that feed', origin);
    }

    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => {});
      return reject(502, `Feed returned HTTP ${upstream.status}`, origin);
    }

    const declared = Number.parseInt(upstream.headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await upstream.body?.cancel().catch(() => {});
      return reject(413, `Feed is larger than the ${Math.round(MAX_BYTES / 1048576)} MB relay limit`, origin);
    }

    // Read fully so the size cap is enforced on real bytes, not just the header.
    const buffer = await upstream.arrayBuffer();
    if (buffer.byteLength > MAX_BYTES) {
      return reject(413, `Feed is larger than the ${Math.round(MAX_BYTES / 1048576)} MB relay limit`, origin);
    }

    const headers = corsHeaders(origin);
    const contentType = upstream.headers.get('content-type');
    if (contentType) headers['content-type'] = contentType;
    // `Response.url` is not guaranteed to be populated after redirects, and an
    // empty value would silently break relative-link resolution in the client.
    headers['x-relay-final-url'] = upstream.url || url.href;
    headers['x-relay-bytes'] = String(buffer.byteLength);
    headers['cache-control'] = 'no-store';

    return new Response(buffer, { status: 200, headers });
  },
};
