// End-to-end write path over real HTTP: a counselor signs in with an invite
// link, saves verdicts, and reads them back — plus the cases that decide
// whether work can be lost or forged.
//
// Requires `npm run api:dev` in another terminal. Creates real rows and
// removes them at the end.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';
import { makeClient } from './http-client.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `sync-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}


const verdict = (scenarioId, because, at = '2026-08-07T10:00:00.000Z') => ({
  scenarioId,
  reviewedAt: at,
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const created = [];

async function addPerson(name) {
  const row = await db.query(
    `insert into people (email, display_name) values ($1, $2) returning id`,
    [`${TAG}-${name.toLowerCase()}@example.com`, `${TAG} ${name}`],
  );
  const id = row.rows[0].id;
  created.push(id);
  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    id,
    minted.prefix,
    minted.hash,
  ]);
  return { id, token: minted.token };
}

try {
  const round = await db.query(`select id from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');
  const roundId = round.rows[0].id;

  const alpha = await addPerson('Alpha');
  const bravo = await addPerson('Bravo');
  for (const p of [alpha, bravo]) {
    await db.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
      roundId,
      p.id,
    ]);
  }

  console.log(`\nWrite path over HTTP (${BASE})\n`);

  const asAlpha = makeClient(BASE);
  const signIn = await asAlpha('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: alpha.token }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.status} ${signIn.text}`);
  ok('signs in with an invite link');

  // --- the outbox drain -----------------------------------------------------
  const batch = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [verdict('routine-001', 'FIRST-VERDICT'), verdict('crisis-001', 'SECOND-VERDICT')],
      deletes: [],
    }),
  });
  if (batch.status === 200 && batch.json.applied.length === 2) ok('saves a batch of two verdicts');
  else bad('batch save', `${batch.status} ${batch.text}`);

  const back = await asAlpha('/api/overlays');
  if (back.text.includes('FIRST-VERDICT') && back.text.includes('SECOND-VERDICT')) {
    ok('reads both verdicts back');
  } else {
    bad('read back', back.text.slice(0, 200));
  }

  // --- last-write-wins ------------------------------------------------------
  const stale = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [verdict('routine-001', 'STALE-FROM-OLD-DEVICE', '2026-08-01T10:00:00.000Z')],
      deletes: [],
    }),
  });
  const afterStale = await asAlpha('/api/overlays');
  if (stale.json.stale?.includes('routine-001') && !afterStale.text.includes('STALE-FROM-OLD')) {
    ok('an older verdict from another device does not overwrite a newer one');
  } else {
    bad('stale write', `stale=${JSON.stringify(stale.json.stale)}`);
  }

  const newer = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [verdict('routine-001', 'NEWER-EDIT', '2026-08-08T10:00:00.000Z')],
      deletes: [],
    }),
  });
  const afterNewer = await asAlpha('/api/overlays');
  if (newer.json.applied.includes('routine-001') && afterNewer.text.includes('NEWER-EDIT')) {
    ok('a newer verdict does replace the older one');
  } else {
    bad('newer write', newer.text);
  }

  // --- idempotency: the outbox may replay -----------------------------------
  const replay = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [verdict('routine-001', 'NEWER-EDIT', '2026-08-08T10:00:00.000Z')],
      deletes: [],
    }),
  });
  if (replay.status === 200 && replay.json.rejected.length === 0) {
    ok('replaying the same write is not an error (beacon and retry both do this)');
  } else {
    bad('replay', replay.text);
  }

  // --- partial success ------------------------------------------------------
  const mixed = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [
        verdict('routine-002', 'A-GOOD-ONE', '2026-08-08T11:00:00.000Z'),
        { ...verdict('routine-003', 'x'), labelVerdict: { kind: 'change', proposed: 'x', because: 'no' } },
      ],
      deletes: [],
    }),
  });
  if (mixed.json.applied.includes('routine-002') && mixed.json.rejected.length === 1) {
    ok('one bad verdict is rejected without stranding the good ones');
  } else {
    bad('partial success', mixed.text);
  }

  // --- identity cannot be forged -------------------------------------------
  await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({
      upserts: [{ ...verdict('crisis-002', 'CLAIMED-AS-BRAVO'), reviewerId: bravo.id }],
      deletes: [],
    }),
  });
  const owner = await db.query(
    `select person_id from reviews where round_id = $1 and scenario_id = 'crisis-002'`,
    [roundId],
  );
  if (owner.rows[0]?.person_id === alpha.id) {
    ok("a spoofed reviewerId is ignored — the verdict is filed under the caller");
  } else {
    bad('identity spoof', `stored under ${owner.rows[0]?.person_id}`);
  }

  // --- delete ---------------------------------------------------------------
  await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [], deletes: ['crisis-002'] }),
  });
  const afterDelete = await asAlpha('/api/overlays');
  if (!afterDelete.text.includes('CLAIMED-AS-BRAVO')) ok('a delete removes the verdict');
  else bad('delete', 'still present');

  const replayDelete = await asAlpha('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [], deletes: ['crisis-002'] }),
  });
  if (replayDelete.status === 200) ok('deleting something already gone is not an error');
  else bad('idempotent delete', replayDelete.text);

  // --- owner-only fields ----------------------------------------------------
  const grab = await asAlpha('/api/proposals/new-forged', {
    method: 'PUT',
    body: JSON.stringify({
      tempId: 'new-forged',
      targetFile: 'input',
      status: 'submitted',
      scenario: { description: 'mine' },
      assignedId: 'routine-999',
      accepted: true,
    }),
  });
  if (grab.status === 400 && grab.text.includes('owner')) {
    ok('a reviewer cannot assign an id or accept their own scenario');
  } else {
    bad('owner field guard', `${grab.status} ${grab.text}`);
  }

  // --- unauthenticated writes ----------------------------------------------
  const stranger = makeClient(BASE);
  const denied = await stranger('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [verdict('routine-001', 'FROM-NOWHERE')], deletes: [] }),
  });
  if (denied.status === 401) ok('an unauthenticated write is refused');
  else bad('unauthenticated write', `${denied.status}`);
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  if (created.length > 0) {
    await db.query('delete from reviews where person_id = any($1::uuid[])', [created]);
    await db.query('delete from proposals where author_id = any($1::uuid[])', [created]);
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [created]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [created]);
    await db.query('delete from people where id = any($1::uuid[])', [created]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Test rows removed.)`);
process.exit(failed === 0 ? 0 : 1);
