// Local dev server: a thin Node http adapter over the same handlers Azure
// Functions will call. Keeping the handlers host-agnostic means `func` tooling
// is not needed to develop or test the API.
//
// Run with `npm run api:dev`.

import { createServer } from 'node:http';
import { closeDb } from './db';
import { parseCookies, runHandler, serialiseCookie, type ApiRequest } from './http';
import { notFoundResponse, route } from './routes';

const PORT = Number(process.env.API_PORT ?? 7071);
// Cookies are only marked Secure over TLS; on plain-http localhost that flag
// would stop the browser storing them at all.
const SECURE_COOKIES = process.env.NODE_ENV === 'production';

// Fail at boot rather than on the first request that needs them. A server that
// starts and then 500s on every sign-in is worse than one that refuses to
// start and says why.
for (const [name, hint] of [
  ['DATABASE_URL', 'Copy .env.example to .env and fill it in.'],
  [
    'SESSION_SECRET',
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"',
  ],
] as const) {
  const value = process.env[name];
  if (!value || (name === 'SESSION_SECRET' && value.length < 32)) {
    console.error(`\n${name} is missing or too short.\n${hint}\n`);
    process.exit(1);
  }
}

async function readBody(request: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // A review file import is the largest legitimate body; anything past this
    // is a mistake or an attack, and either way we should not buffer it.
    if (size > 8 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

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
    headers['Set-Cookie'] = response.setCookies.map((c) => serialiseCookie(c, SECURE_COOKIES));
  }
  if (response.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';

  res.writeHead(response.status, headers);
  res.end(response.body === undefined ? undefined : JSON.stringify(response.body));

  const marker = response.status >= 400 ? '!' : ' ';
  console.log(`${marker} ${request.method} ${request.path} -> ${response.status}`);
});

// Bind explicitly rather than letting Node pick: an unspecified host listens
// on :: and the Vite proxy may reach for 127.0.0.1, which then hangs.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`api listening on http://127.0.0.1:${PORT}`);
  console.log(`  health: http://127.0.0.1:${PORT}/api/health`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closeDb().then(() => process.exit(0));
    });
  });
}
