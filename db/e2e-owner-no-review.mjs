// §6.2 — the owner administers and does not review.
//
// Three layers have to agree, and this checks all three:
//   1. the API refuses an owner's verdict with a reason, not a stack trace
//   2. the owner is not a participant, so the FK makes it impossible anyway
//   3. the owner never appears in the reviewer roster or the agreement inputs
//
// The reason it matters: the owner sees every verdict by design, so their own
// answer could not be independent, and counting it would contaminate the
// inter-rater number the whole exercise produces.
//
// Requires `npm run api:dev`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `noreview-${randomUUID().slice(0, 8)}`;

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
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
}

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const verdict = (scenarioId) => ({
  scenarioId,
  reviewedAt: minutesAgo(5),
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because: 'OWNER-SHOULD-NOT-BE-ABLE' },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const made = [];

try {
  const round = await db.query(`select id from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');
  const roundId = round.rows[0].id;

  const ownerRow = await db.query(`select id, display_name from people where role='owner' limit 1`);
  if (ownerRow.rowCount === 0) throw new Error('No owner. Run `npm run db:seed` first.');
  const owner = ownerRow.rows[0];

  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    owner.id,
    minted.prefix,
    minted.hash,
  ]);

  // A real counselor, so the comparisons below are against something working.
  const counselor = await db.query(
    `insert into people (email, display_name) values ($1, $2) returning id`,
    [`${TAG}@example.com`, `${TAG} Counselor`],
  );
  made.push(counselor.rows[0].id);
  const cMint = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    counselor.rows[0].id,
    cMint.prefix,
    cMint.hash,
  ]);
  await db.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
    roundId,
    counselor.rows[0].id,
  ]);

  console.log(`\nOwner administers, does not review (${BASE})\n`);

  const asOwner = makeClient();
  const signIn = await asOwner('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: minted.token }),
  });
  if (signIn.status === 200 && signIn.json.role === 'owner') ok('owner signs in');
  else bad('owner sign-in', signIn.text);

  // --- 1. the API refuses, with a reason -----------------------------------
  const batch = await asOwner('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [verdict('routine-001')], deletes: [] }),
  });
  if (batch.status === 403 && /does not record verdicts/i.test(batch.text)) {
    ok('a batched verdict from the owner is refused, and says why');
  } else {
    bad('batch refusal', `${batch.status} ${batch.text.slice(0, 200)}`);
  }

  const single = await asOwner('/api/reviews/routine-001', {
    method: 'PUT',
    body: JSON.stringify(verdict('routine-001')),
  });
  if (single.status === 403) ok('the single-verdict route refuses too');
  else bad('single refusal', `${single.status}`);

  const authored = await asOwner('/api/proposals/new-owner-test', {
    method: 'PUT',
    body: JSON.stringify({
      tempId: 'new-owner-test',
      targetFile: 'input',
      status: 'draft',
      scenario: { description: 'x' },
    }),
  });
  if (authored.status === 403) ok('authoring a scenario as the owner is refused');
  else bad('proposal refusal', `${authored.status}`);

  // --- 2. nothing was written ----------------------------------------------
  const stored = await db.query(
    'select count(*)::int as n from reviews where person_id = $1',
    [owner.id],
  );
  if (stored.rows[0].n === 0) ok('no owner verdict exists in the database');
  else bad('owner verdicts', `${stored.rows[0].n} rows`);

  // --- 3. the FK is the structural backstop --------------------------------
  const participation = await db.query(
    'select count(*)::int as n from round_participants where person_id = $1',
    [owner.id],
  );
  if (participation.rows[0].n === 0) ok('the owner is not a participant in any batch');
  else bad('participation', `${participation.rows[0].n} rows`);

  // Bypass the API entirely: the database itself must refuse. Wrapped in a
  // real transaction — savepoints need one, and this way the attempt cannot
  // leave a row behind even if it unexpectedly succeeds.
  let dbRefused = false;
  await db.query('begin');
  try {
    await db.query(
      `insert into reviews (round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
                            reviewed_at, label_verdict, rationale_verdict, realism_verdict)
       values ($1,$2,'routine-001','input',$3::text,$3::timestamptz,
               '{"kind":"agree"}'::jsonb,'{"kind":"sound"}'::jsonb,'{"kind":"realistic"}'::jsonb)`,
      [roundId, owner.id, minutesAgo(1)],
    );
  } catch (error) {
    dbRefused = /round_id_person_id_fkey|foreign key/i.test(error.message);
  } finally {
    await db.query('rollback');
  }
  if (dbRefused) {
    ok('a direct SQL insert of an owner verdict is refused by the foreign key');
  } else {
    bad('structural guarantee', 'the database accepted an owner verdict');
  }

  // --- 4. the owner is not in the reviewer roster --------------------------
  const progress = await asOwner('/api/admin/progress');
  const names = (progress.json.reviewers ?? []).map((r) => r.displayName);
  if (!names.includes(owner.display_name)) {
    ok('the owner does not appear in the batch progress roster');
  } else {
    bad('roster', `owner listed: ${JSON.stringify(names)}`);
  }

  const overlays = await asOwner('/api/admin/export/overlays');
  const files = overlays.json.files ?? [];
  if (!files.some((f) => f.overlay.reviewer.displayName === owner.display_name)) {
    ok('the owner contributes no overlay to the archival export');
  } else {
    bad('overlay export', 'owner overlay present');
  }

  // --- 5. a real counselor still works ------------------------------------
  const asCounselor = makeClient();
  await asCounselor('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: cMint.token }),
  });
  const good = await asCounselor('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [verdict('routine-001')], deletes: [] }),
  });
  if (good.status === 200 && good.json.applied.includes('routine-001')) {
    ok('a counselor can still record a verdict — the guard is role-specific');
  } else {
    bad('counselor write', `${good.status} ${good.text.slice(0, 200)}`);
  }

  // --- 6. the owner still administers -------------------------------------
  const stillOwner = await asOwner('/api/admin/people');
  if (stillOwner.status === 200) ok('the owner keeps full admin access without participating');
  else bad('admin access', `${stillOwner.status}`);
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  if (made.length > 0) {
    await db.query('delete from reviews where person_id = any($1::uuid[])', [made]);
    await db.query('delete from proposals where author_id = any($1::uuid[])', [made]);
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [made]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [made]);
    await db.query('delete from people where id = any($1::uuid[])', [made]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Test rows removed.)`);
process.exit(failed === 0 ? 0 : 1);
