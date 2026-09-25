#!/usr/bin/env node
/**
 * Tiny static server for development and tests. localhost counts as a
 * secure context, so camera access and the service worker work.
 *
 *   node scripts/serve.mjs [--port 8080] [--host 127.0.0.1]
 *
 * Phones on your network need HTTPS for the camera; see README.
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.md': 'text/markdown; charset=utf-8',
};

/**
 * `overrides` (tests only): Map of request path -> {body, type} served
 * instead of the file on disk, e.g. a newer sw.js to exercise updates.
 */
export function startServer({ port = 8080, host = '127.0.0.1', quiet = false, overrides = null } = {}) {
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const override = overrides?.get(url.pathname);
    if (override) {
      res.writeHead(200, { 'Content-Type': override.type, 'Cache-Control': 'no-cache' }).end(override.body);
      return;
    }
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(ROOT, path);
    if (!file.startsWith(ROOT + sep) && file !== ROOT) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      if (!quiet) console.log(`404 ${url.pathname}`);
      return;
    }
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolveStart) => server.listen(port, host, () => resolveStart(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : fallback;
  };
  const port = Number(arg('--port', process.env.PORT ?? 8080));
  const host = arg('--host', '127.0.0.1');
  startServer({ port, host }).then(() => console.log(`Laundry Color Scanner: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}/`));
}
