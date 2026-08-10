// End-to-end proof over real HTTP: two counselors, real invite links, real
// cookies, and an assertion on the raw response body.
//
// The unit and integration tests check loadOverlayView directly. This checks
// the thing a browser actually receives, which is the only surface that
// matters for a leak. Requires `npm run api:dev` in another terminal.
//
// Creates real rows and cleans them up at the end.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';
import { makeClient } from './http-client.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `e2e-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}

/** Minimal cookie-jar fetch. */

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();

const created = { people: [], round: null };

async function addPerson(name, role = 'reviewer') {
  const row = await db.query(
    `insert into people (email, display_name, role) values ($1, $2, $3) returning id`,
    [`${TAG}-${name.toLowerCase()}@example.com`, `${TAG} ${name}`, role],
  );
  const id = row.rows[0].id;
  created.people.push(id);
  const minted = mintToken();
  await db.query(
    `insert into invites (person_id, token_prefix, token_hash) values ($1, $2, $3)`,
    [id, minted.prefix, minted.hash],
  );
  return { id, token: minted.token };
}

try {
  // The seeded round is the open one; enrol our two counselors into it so we
  // exercise the same path a real reviewer takes.
  const round = await db.query(`select id from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');
  created.round = round.rows[0].id;

  const alpha = await addPerson('Alpha');
  const bravo = await addPerson('Bravo');
  for (const p of [alpha, bravo]) {
    await db.query(`insert into round_participants (round_id, person_id) values ($1, $2)`, [
      created.round,
      p.id,
    ]);
  }

  const SECRET = 'BRAVO-SECRET-REASONING-DO-NOT-LEAK';
  const put = (personId, scenarioId, because) =>
    db.query(
      `insert into reviews (round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
                            reviewed_at, label_verdict, rationale_verdict, realism_verdict)
       values ($1,$2,$3,'input',$4::text,$4::timestamptz,$5::jsonb,
               '{"kind":"sound"}'::jsonb,'{"kind":"realistic"}'::jsonb)`,
      [
        created.round,
        personId,
        scenarioId,
        '2026-08-06T12:00:00.000Z',
        JSON.stringify({ kind: 'change', proposed: 'pause_and_route', because }),
      ],
    );

  // Bravo has answered two scenarios. Alpha has answered one of them.
  await put(bravo.id, 'routine-001', 'BRAVO-ON-ROUTINE-001');
  await put(bravo.id, 'crisis-001', SECRET);
  await put(alpha.id, 'routine-001', 'ALPHA-OWN-VIEW');

  console.log(`\nBlind rule over HTTP (${BASE})\n`);

  const asAlpha = makeClient(BASE);
  const signIn = await asAlpha('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: alpha.token }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${signIn.text}`);
  ok('Alpha signs in with her invite link');

  const overlays = await asAlpha('/api/overlays');
  if (overlays.status !== 200) throw new Error(`overlays failed: ${overlays.status}`);

  // The assertions that matter, against the raw bytes.
  if (overlays.text.includes('BRAVO-ON-ROUTINE-001')) {
    ok("sees Bravo's verdict on routine-001, which she has answered");
  } else {
    bad('should see earned verdict', 'BRAVO-ON-ROUTINE-001 missing from body');
  }

  if (!overlays.text.includes(SECRET)) {
    ok("does NOT see Bravo's reasoning on crisis-001, which she has not answered");
  } else {
    bad('LEAK', `raw body contained ${SECRET}`);
  }

  if (!overlays.text.includes('crisis-001')) {
    ok('the unanswered scenario id does not appear at all');
  } else {
    bad('LEAK', 'body mentioned crisis-001');
  }

  if (!overlays.text.includes('@example.com')) ok('no email in the body');
  else bad('LEAK', 'body contained an email address');

  // Now Alpha answers it, and the same request returns more.
  await put(alpha.id, 'crisis-001', 'ALPHA-NOW-ANSWERED');
  const after = await asAlpha('/api/overlays');
  if (after.text.includes(SECRET)) {
    ok("after answering crisis-001, Bravo's reasoning becomes visible");
  } else {
    bad('should unlock', 'still hidden after answering');
  }

  // A signed-out client gets nothing.
  const stranger = makeClient(BASE);
  const denied = await stranger('/api/overlays');
  if (denied.status === 401) ok('an unauthenticated request is refused (401)');
  else bad('should be 401', `got ${denied.status}`);
} catch (error) {
  bad('harness', error.message);
} finally {
  if (created.people.length > 0) {
    await db.query('delete from reviews where person_id = any($1::uuid[])', [created.people]);
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [created.people]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [created.people]);
    await db.query('delete from people where id = any($1::uuid[])', [created.people]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Test rows removed.)`);
process.exit(failed === 0 ? 0 : 1);
