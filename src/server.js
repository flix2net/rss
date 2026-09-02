/**
 * Local HTTP server: serves the GUI and a same-origin JSON API.
 *
 * Binds to 127.0.0.1 by default. POSTs must carry the `x-rss-extractor` header,
 * which forces a CORS preflight that no third-party website can satisfy — so a
 * random page cannot get this server to fetch URLs on its behalf.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFeeds, DEFAULTS } from './extract.js';
import { LIMITS } from './feed.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, '..', 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const MAX_BODY_BYTES = 1024 * 1024;

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Body is not valid JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload));
}

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, relative);
  // Reject anything that escapes the public directory.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
  }
  fs.readFile(target, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    send(res, 200, data, {
      'content-type': MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': target.endsWith('.html') ? 'no-store' : 'no-cache',
    });
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    if (url.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, tool: 'rss-feed-extractor', limits: LIMITS, defaults: DEFAULTS });
    }

    if (url.pathname === '/api/extract') {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { error: 'Use POST' }, { allow: 'POST' });
      }
      if (req.headers['x-rss-extractor'] === undefined) {
        return sendJson(res, 403, { error: 'Missing x-rss-extractor header' });
      }
      try {
        const body = await readJsonBody(req);
        const result = await extractFeeds(body);
        return sendJson(res, 200, result);
      } catch (err) {
        const status = err?.statusCode ?? (err?.code === 'no_urls' || err?.code === 'invalid_url' ? 400 : 500);
        return sendJson(res, status, { error: err?.message ?? String(err), code: err?.code ?? 'internal_error' });
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return send(res, 404, 'Not found', { 'content-type': 'text/plain; charset=utf-8' });
    }
    if (url.pathname === '/favicon.ico') {
      return send(res, 204, '');
    }
    return serveStatic(res, url.pathname);
  });
}

/**
 * Starts the server, retrying upward if the port is taken.
 * @returns {Promise<{server: http.Server, port: number, host: string}>}
 */
export function startServer({ port = 5055, host = '127.0.0.1', tries = 20 } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    let remaining = tries;

    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && remaining > 0) {
        remaining -= 1;
        port += 1;
        server.listen(port, host);
        return;
      }
      reject(err);
    };

    server.on('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      const bound = server.address();
      resolve({ server, port: bound?.port ?? port, host });
    });
  });
}
