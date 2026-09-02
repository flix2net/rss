/**
 * Network layer: fetches feed documents with a browser-ish User-Agent, a hard
 * byte ceiling and correct legacy-charset handling. Uses only Node built-ins.
 */

import { LIMITS } from './feed.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Chrome/124.0.0.0 Safari/537.36 rss-feed-extractor/1.0';

/** WHATWG encoding spec: `iso-8859-1` labels actually mean windows-1252. */
const ENCODING_ALIASES = {
  'iso-8859-1': 'windows-1252',
  'iso8859-1': 'windows-1252',
  'latin-1': 'windows-1252',
  latin1: 'windows-1252',
  'us-ascii': 'windows-1252',
  ascii: 'windows-1252',
  gb2312: 'gbk',
  'x-sjis': 'shift_jis',
  'euc-kr': 'euc-kr',
  koi8u: 'koi8-r',
};

const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal']);

export class FetchError extends Error {
  constructor(message, { code = 'fetch_failed', status = null, url = null } = {}) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
    this.url = url;
  }
}

/**
 * Blocks loopback/private/link-local targets so that the local server cannot be
 * pointed at an internal network by accident. Opt out with `allowPrivate`.
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
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
}

export function normalizeFeedUrl(input) {
  const raw = String(input ?? '').trim().replace(/^<|>$/g, '');
  if (!raw) throw new FetchError('Empty URL', { code: 'invalid_url' });
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new FetchError(`Not a valid URL: ${raw}`, { code: 'invalid_url' });
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new FetchError(`Unsupported protocol "${url.protocol}"`, { code: 'unsupported_protocol', url: raw });
  }
  return url;
}

function detectEncoding(buffer, contentType) {
  const fromHeader = contentType?.match(/charset\s*=\s*"?([\w-]+)"?/i)?.[1];
  if (fromHeader) return fromHeader.toLowerCase();

  // XML declaration lives in the first few hundred bytes, always ASCII-safe.
  const head = new TextDecoder('latin1').decode(buffer.subarray(0, Math.min(buffer.length, 512)));
  const fromXml = head.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1];
  if (fromXml) return fromXml.toLowerCase();

  const fromJsonFeed = head.match(/"encoding"\s*:\s*"([\w-]+)"/i)?.[1];
  if (fromJsonFeed) return fromJsonFeed.toLowerCase();

  return 'utf-8';
}

function decode(buffer, label) {
  const normalized = ENCODING_ALIASES[label] ?? label;
  try {
    return new TextDecoder(normalized, { fatal: false }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252', { fatal: false }).decode(buffer);
  }
}

/**
 * Downloads and decodes one feed.
 *
 * @param {string|URL} target
 * @param {{timeoutMs?: number, maxBytes?: number, userAgent?: string, allowPrivate?: boolean}} [options]
 * @returns {Promise<{text: string, url: string, status: number, bytes: number,
 *   contentType: string, encoding: string, elapsedMs: number}>}
 */
export async function fetchFeed(target, options = {}) {
  const {
    timeoutMs = 20_000,
    maxBytes = LIMITS.maxBytes,
    userAgent = DEFAULT_USER_AGENT,
    allowPrivate = false,
  } = options;

  const url = target instanceof URL ? target : normalizeFeedUrl(target);
  if (!allowPrivate && isPrivateHost(url.hostname)) {
    throw new FetchError(`Refusing to fetch private/internal host "${url.hostname}"`, {
      code: 'blocked_host', url: url.href,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const startedAt = Date.now();

  let response;
  try {
    response = await fetch(url.href, {
      redirect: 'follow',
      signal: controller.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: {
        'user-agent': userAgent,
        accept: 'application/rss+xml, application/atom+xml, application/feed+json, '
          + 'application/xml;q=0.9, text/xml;q=0.8, application/json;q=0.7, */*;q=0.5',
        'accept-language': 'en-US,en;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    });
  } catch (err) {
    const timedOut = err?.name === 'AbortError' || controller.signal.aborted;
    throw new FetchError(
      timedOut ? `Timed out after ${timeoutMs} ms` : `Network error: ${err.cause?.code ?? err.message}`,
      { code: timedOut ? 'timeout' : 'network_error', url: url.href },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new FetchError(`HTTP ${response.status} ${response.statusText}`.trim(), {
      code: 'http_status', status: response.status, url: response.url || url.href,
    });
  }

  const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FetchError(`Feed is ${Math.round(declaredLength / 1024)} KB, over the ${Math.round(maxBytes / 1048576)} MB limit`, {
      code: 'too_large', url: response.url || url.href,
    });
  }

  const chunks = [];
  let received = 0;
  try {
    if (response.body) {
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        if (received > maxBytes) {
          await response.body.cancel().catch(() => {});
          throw new FetchError(`Feed exceeded the ${Math.round(maxBytes / 1048576)} MB limit`, {
            code: 'too_large', url: response.url || url.href,
          });
        }
        chunks.push(chunk);
      }
    }
  } catch (err) {
    if (err instanceof FetchError) throw err;
    throw new FetchError(`Download failed: ${err.cause?.code ?? err.message}`, {
      code: 'network_error', url: response.url || url.href,
    });
  }

  const buffer = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const contentType = response.headers.get('content-type') ?? '';
  const encoding = detectEncoding(buffer, contentType);
  const text = decode(buffer, encoding);

  if (!buffer.byteLength) {
    throw new FetchError('Server returned an empty body', { code: 'empty_body', url: response.url || url.href });
  }

  return {
    text,
    url: response.url || url.href,
    status: response.status,
    bytes: received,
    contentType,
    encoding,
    elapsedMs: Date.now() - startedAt,
  };
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, preserving order.
 * Never rejects: `fn` is expected to return a settled result object.
 */
export async function mapLimit(items, limit, fn) {
  const size = Math.max(1, Math.min(limit | 0 || 1, items.length || 1));
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: size }, worker));
  return results;
}
