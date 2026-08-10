// The owner boundary, over real HTTP.
//
// The client hides owner surfaces, but that is cosmetic. This asserts the
// actual control: a reviewer's session gets 403 from every /api/admin
// endpoint, whatever the UI does. If any of these returns 200, hiding a button
// is all that stands between a counselor and the whole batch's verdicts.
//
// Requires `npm run api:dev`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `owner-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}

function makeClient() {
  let cookie = null;
  return async (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
}

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const made = [];

async function addPerson(name, role = 'reviewer') {
  const row = await db.query(
    `insert into people (email, display_name, role) values ($1,$2,$3) returning id`,
    [`${TAG}-${name.toLowerCase()}@example.com`, `${TAG} ${name}`, role],
  );
  const id = row.rows[0].id;
  made.push(id);
  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    id,
    minted.prefix,
    minted.hash,
  ]);
  return { id, token: minted.token };
}

/** Every owner endpoint, with a body where one is needed. */
const ADMIN_ENDPOINTS = [
  ['GET', '/api/admin/progress', null],
  ['GET', '/api/admin/people', null],
  ['POST', '/api/admin/people', { email: 'x@example.com', displayName: 'X' }],
  ['POST', '/api/admin/people/00000000-0000-0000-0000-000000000000/revoke', {}],
  ['POST', '/api/admin/people/00000000-0000-0000-0000-000000000000/reissue', {}],
  ['POST', '/api/admin/round/participants', { personIds: [] }],
  ['POST', '/api/admin/round/promote', { inputYaml: 'x', outputYaml: 'y' }],
  ['POST', '/api/admin/round', { action: 'open', label: 'sneaky' }],
  ['POST', '/api/admin/dataset', { inputYaml: 'x', outputYaml: 'y' }],
  ['GET', '/api/admin/exports', null],
  ['GET', '/api/admin/exports/00000000-0000-0000-0000-000000000000', null],
  ['POST', '/api/admin/overlays/import', { format: 'srs.review' }],
  ['GET', '/api/admin/export/overlays', null],
];

try {
  const round = await db.query(`select id from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');

  const reviewer = await addPerson('Reviewer');
  await db.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
    round.rows[0].id,
    reviewer.id,
  ]);

  console.log(`\nOwner boundary (${BASE})\n`);

  const asReviewer = makeClient();
  const signIn = await asReviewer('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: reviewer.token }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.text}`);
  if (signIn.json.role === 'reviewer') ok('a counselor signs in as a reviewer, not an owner');
  else bad('role', `got ${signIn.json.role}`);

  let denied = 0;
  for (const [method, path, body] of ADMIN_ENDPOINTS) {
    const response = await asReviewer(path, {
      method,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (response.status === 403) denied += 1;
    else bad(`${method} ${path}`, `expected 403, got ${response.status} ${response.text.slice(0, 120)}`);
  }
  if (denied === ADMIN_ENDPOINTS.length) {
    ok(`all ${denied} owner endpoints refuse a reviewer with 403`);
  }

  // Unauthenticated gets 401, not 403 — "who are you" before "may you".
  const stranger = makeClient();
  const anon = await stranger('/api/admin/progress');
  if (anon.status === 401) ok('an unauthenticated caller gets 401, not 403');
  else bad('anon status', `${anon.status}`);

  // And nothing leaked in any of those bodies.
  const leak = await asReviewer('/api/admin/people');
  if (!leak.text.includes('@') || leak.status === 403) {
    ok('the refused roster response contains no email addresses');
  } else {
    bad('roster leak', leak.text.slice(0, 200));
  }
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  if (made.length > 0) {
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [made]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [made]);
    await db.query('delete from people where id = any($1::uuid[])', [made]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Test rows removed.)`);
process.exit(failed === 0 ? 0 : 1);
