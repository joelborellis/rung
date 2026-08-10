// Bring existing .review.json files into the database.
//
// This is the migration path for work done before the backend existed, and the
// rescue path for a counselor whose sync never worked. It posts each file to
// /api/admin/overlays/import, which merges rather than overwrites and maps the
// file's old slug identity onto a real person row.
//
//   node db/import-review-files.mjs --owner-token <token> ./exports/*.review.json
//
// A file whose reviewer is not already known needs an email to link it to:
//
//   node db/import-review-files.mjs --owner-token <t> --email jane@x.com jane.review.json

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { env as readEnv } from './env.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const ownerToken = arg('owner-token') ?? readEnv().OWNER_TOKEN;
const email = arg('email');
const files = process.argv.slice(2).filter((a) => a.endsWith('.review.json'));

if (!ownerToken) {
  console.error(
    'Need an owner invite token: --owner-token <token>, or OWNER_TOKEN in .env.\n' +
      'Get one with: node db/seed.mjs --reissue',
  );
  process.exit(1);
}
if (files.length === 0) {
  console.error('No .review.json files given.');
  process.exit(1);
}

let cookie = null;
async function call(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (cookie) headers.cookie = cookie;
  if (init.body) headers['content-type'] = 'application/json';
  const response = await fetch(`${BASE}${path}`, { ...init, headers });
  const set = response.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null, text };
}

const signIn = await call('/api/session', {
  method: 'POST',
  body: JSON.stringify({ token: ownerToken }),
});
if (signIn.status !== 200) {
  console.error(`Sign-in failed: ${signIn.status} ${signIn.text}`);
  process.exit(1);
}
if (signIn.json.role !== 'owner') {
  console.error('That token is not the owner\'s.');
  process.exit(1);
}
console.log(`Signed in as ${signIn.json.reviewer.displayName}\n`);

let imported = 0;
let failed = 0;

for (const path of files) {
  const name = basename(path);
  let file;
  try {
    file = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.log(`  SKIP  ${name} — not valid JSON (${error.message})`);
    failed += 1;
    continue;
  }

  const body = email ? { ...file, email } : file;
  const result = await call('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify(body),
  });

  if (result.status !== 200) {
    console.log(`  FAIL  ${name} — ${result.json?.error?.message ?? result.status}`);
    failed += 1;
    continue;
  }

  const { person, imported: count, skipped, proposals } = result.json;
  console.log(
    `  OK    ${name} → ${person.displayName}: ${count} verdicts, ${proposals} proposals`,
  );
  // Named rather than silently dropped: usually a sign the file belongs to a
  // different scenario set than the batch that is currently open.
  if (skipped.length > 0) {
    console.log(`        ${skipped.length} skipped (not in this batch): ${skipped.join(', ')}`);
  }
  imported += 1;
}

console.log(`\n${imported} imported, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
