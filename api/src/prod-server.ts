// The production entry point: one process serving both the built SPA and /api.
//
// Same-origin is not a convenience here, it is what three things depend on:
// the session cookie can be HttpOnly + SameSite=Strict, sendBeacon works on tab
// close (it cannot set headers), and there is no CORS to misconfigure. Splitting
// the SPA onto a CDN would cost all three, so one process serves both.
//
// Deliberately no Express. The routing this needs is "does the path start with
// /api" plus a static file read; a framework would be a dependency to audit for
// forty lines of logic.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { closeDb } from './db';
import { parseCookies, runHandler, serialiseCookie, type ApiRequest } from './http';
import { notFoundResponse, route } from './routes';

const PORT = Number(process.env.PORT ?? 8080);
const DIST = resolve(process.env.STATIC_DIR ?? 'dist');

// Azure terminates TLS at the front end and forwards over http, so trusting the
// socket would silently drop the Secure flag and the cookie with it.
const BEHIND_TLS = process.env.NODE_ENV === 'production';

for (const [name, hint] of [
  ['DATABASE_URL', 'Set it in the App Service configuration.'],
  [
    'SESSION_SECRET',
    "Set it in the App Service configuration. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"",
  ],
] as const) {
  const value = process.env[name];
  if (!value || (name === 'SESSION_SECRET' && value.length < 32)) {
    console.error(`FATAL: ${name} is missing or too short. ${hint}`);
    process.exit(1);
  }
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error(`FATAL: no built app at ${DIST}. Run \`npm run build\` before starting.`);
  process.exit(1);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // A review-file import is the largest legitimate body. Past this it is a
    // mistake or an attack, and either way we should not buffer it.
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Resolve a URL path inside DIST, or null if it escapes.
 *
 * `..` in a request path is the oldest trick there is; normalising and then
 * checking the result is still under DIST is what stops it reading /etc.
 */
function safeStaticPath(urlPath: string): string | null {
  const decoded = (() => {
    try {
      return decodeURIComponent(urlPath);
    } catch {
      return urlPath;
    }
  })();
  const candidate = normalize(join(DIST, decoded));
  if (!candidate.startsWith(DIST)) return null;
  return candidate;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // ---------------------------------------------------------------- API ---
  if (url.pathname.startsWith('/api/')) {
    const request: ApiRequest = {
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers as Record<string, string | undefined>,
      cookies: parseCookies(req.headers.cookie),
      body: await readBody(req).catch(() => undefined),
    };

    const handler = route(request);
    const response = handler ? await runHandler(handler, request) : notFoundResponse;

    const headers: Record<string, string | string[]> = {
      'Cache-Control': 'no-store',
      ...(response.headers ?? {}),
    };
    if (response.setCookies?.length) {
      headers['Set-Cookie'] = response.setCookies.map((c) => serialiseCookie(c, BEHIND_TLS));
    }
    if (response.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';

    res.writeHead(response.status, headers);
    res.end(response.body === undefined ? undefined : JSON.stringify(response.body));
    if (response.status >= 400) console.log(`! ${request.method} ${request.path} -> ${response.status}`);
    return;
  }

  // ------------------------------------------------------------- static ---
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    res.end();
    return;
  }

  const requested = safeStaticPath(url.pathname === '/' ? '/index.html' : url.pathname);
  if (!requested) {
    res.writeHead(400);
    res.end();
    return;
  }

  const isFile = existsSync(requested) && statSync(requested).isFile();
  // Hash-routed SPA: any path that is not a real file is the app itself. The
  // token in #/t/<token> never reaches here — fragments are not sent.
  const file = isFile ? requested : join(DIST, 'index.html');
  const ext = extname(file);

  res.writeHead(200, {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    // Vite fingerprints assets, so they are immutable. index.html must never be
    // cached, or a deploy leaves clients on the old bundle indefinitely.
    'Cache-Control': file.endsWith('index.html')
      ? 'no-cache'
      : 'public, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });

  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`rung listening on :${PORT}`);
  console.log(`  serving ${DIST}`);
  console.log(`  secure cookies: ${BEHIND_TLS}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`${signal} — draining`);
    server.close(() => void closeDb().then(() => process.exit(0)));
    // Azure gives ~30s on a restart; do not hang past it.
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
