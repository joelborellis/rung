// AC-15: two full batches end to end, over real HTTP.
//
// This is the criterion that proves the loop the app actually exists for:
//
//   enrol → review → resolve → promote merged YAML to the next canon → repeat
//
// The assertions that matter are the ones about batch 2:
//   * a RETURNING counselor uses the SAME link — no reissue between batches
//   * the promoted canon carries batch 1's accepted corrections
//   * batch 2 reviewers see NO batch-1 verdicts — a new batch is a fresh blind
//     slate even for someone who was in batch 1
//   * the archived export bytes are byte-identical to what the owner promoted
//
// Runs against a scratch round so it cannot disturb a live batch, and removes
// everything it made. Requires `npm run api:dev`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `batch-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

const sha = (t) => createHash('sha256').update(t, 'utf8').digest('hex');

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

// A tiny two-scenario canon, so the "promoted bytes" comparison is readable.
const CANON_V1_INPUT = `# test canon
scenarios:
  - id: t-001
    expected_tier: no_issue
    reviewed_by: "UNREVIEWED"
  - id: t-002
    expected_tier: no_issue
    reviewed_by: "UNREVIEWED"
`;
const CANON_V1_OUTPUT = `# test canon
scenarios:
  - id: o-001
    expected_result: true
    reviewed_by: "UNREVIEWED"
`;
// What the owner's browser would produce after accepting a tier change.
const CANON_V2_INPUT = CANON_V1_INPUT.replace(
  '  - id: t-001\n    expected_tier: no_issue',
  '  - id: t-001\n    expected_tier: pause_and_route',
).replace('  - id: t-001\n    expected_tier: pause_and_route\n    reviewed_by: "UNREVIEWED"',
  '  - id: t-001\n    expected_tier: pause_and_route\n    reviewed_by: "AB 2026-08-07: tier→pause_and_route"');

const IDS = { input: ['t-001', 't-002'], output: ['o-001'] };

// Relative to now, never a hard-coded future date: the API rejects a
// reviewedAt more than a day ahead as clock skew, and a fixture that trips
// that guard makes later assertions pass vacuously.
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const verdict = (scenarioId, because, at) => ({
  scenarioId,
  reviewedAt: at,
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

/** Post a verdict and fail loudly if the server did not store it. */
async function save(client, who, scenarioId, because, at) {
  const response = await client('/api/reviews:batch', {
    method: 'POST',
    body: JSON.stringify({ upserts: [verdict(scenarioId, because, at)], deletes: [] }),
  });
  if (response.status !== 200 || !response.json.applied.includes(scenarioId)) {
    throw new Error(
      `${who}'s verdict on ${scenarioId} was not stored: ${response.status} ${response.text}`,
    );
  }
  return response;
}

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const madePeople = [];
const madeRounds = [];
let previouslyOpen = null;

async function addPerson(name, role = 'reviewer') {
  const row = await db.query(
    `insert into people (email, display_name, role) values ($1,$2,$3) returning id`,
    [`${TAG}-${name.toLowerCase()}@example.com`, `${TAG} ${name}`, role],
  );
  const id = row.rows[0].id;
  madePeople.push(id);
  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    id,
    minted.prefix,
    minted.hash,
  ]);
  return { id, token: minted.token, name };
}

try {
  // Park the live round so our scratch batch can be the open one.
  const live = await db.query(`select id from rounds where status = 'open'`);
  previouslyOpen = live.rows[0]?.id ?? null;
  if (previouslyOpen) {
    await db.query(`update rounds set status = 'closed' where id = $1`, [previouslyOpen]);
  }

  const owner = await addPerson('Owner', 'owner');
  const alpha = await addPerson('Alpha');
  const bravo = await addPerson('Bravo');

  const asOwner = makeClient();
  const asAlpha = makeClient();
  const asBravo = makeClient();

  console.log(`\nAC-15 — two batches end to end (${BASE})\n`);
  console.log('--- Batch 1 ---');

  await asOwner('/api/session', { method: 'POST', body: JSON.stringify({ token: owner.token }) });

  const opened = await asOwner('/api/admin/round', {
    method: 'POST',
    body: JSON.stringify({ action: 'open', label: `${TAG} one` }),
  });
  if (opened.status !== 200) throw new Error(`open failed: ${opened.text}`);
  madeRounds.push(opened.json.round.id);
  ok('owner opens batch 1');

  const uploaded = await asOwner('/api/admin/dataset', {
    method: 'POST',
    body: JSON.stringify({
      inputYaml: CANON_V1_INPUT,
      outputYaml: CANON_V1_OUTPUT,
      fileHash: 'testhash1',
      scenarioIds: IDS,
    }),
  });
  if (uploaded.status === 200) ok('owner attaches the scenario set');
  else bad('dataset upload', uploaded.text);

  await db.query(
    `insert into round_participants (round_id, person_id) values ($1,$2), ($1,$3)`,
    [opened.json.round.id, alpha.id, bravo.id],
  );

  await asAlpha('/api/session', { method: 'POST', body: JSON.stringify({ token: alpha.token }) });
  await asBravo('/api/session', { method: 'POST', body: JSON.stringify({ token: bravo.token }) });
  ok('two counselors sign in with their links');

  await save(asAlpha, 'Alpha', 't-001', 'ALPHA-BATCH1-REASONING', minutesAgo(60));
  await save(asBravo, 'Bravo', 't-001', 'BRAVO-BATCH1-REASONING', minutesAgo(55));
  ok('both review the same scenario');

  const dash = await asOwner('/api/admin/progress');
  if (dash.status === 200 && dash.json.reviewers.length >= 2 && dash.json.unresolvedContested >= 2) {
    ok(`dashboard shows ${dash.json.reviewers.length} reviewers and unresolved contested items`);
  } else {
    bad('progress', dash.text.slice(0, 300));
  }

  const key = `t-001::${alpha.id}::label`;
  const resolved = await asOwner(`/api/resolutions/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({
      scenarioId: 't-001',
      reviewerId: alpha.id,
      concern: 'label',
      decision: 'accept',
      resolvedAt: minutesAgo(30),
    }),
  });
  if (resolved.status === 200) ok("owner accepts Alpha's proposed tier");
  else bad('resolve', resolved.text);

  // --- Promote --------------------------------------------------------------
  console.log('\n--- Promotion ---');

  const wrongConfirm = await asOwner('/api/admin/round/promote', {
    method: 'POST',
    body: JSON.stringify({
      inputYaml: CANON_V2_INPUT,
      outputYaml: CANON_V1_OUTPUT,
      fileHash: 'testhash2',
      scenarioIds: IDS,
      nextLabel: `${TAG} two`,
      confirm: 'wrong',
    }),
  });
  if (wrongConfirm.status === 400) ok('promotion refuses without the batch name typed');
  else bad('confirm guard', `${wrongConfirm.status}`);

  const promoted = await asOwner('/api/admin/round/promote', {
    method: 'POST',
    body: JSON.stringify({
      inputYaml: CANON_V2_INPUT,
      outputYaml: CANON_V1_OUTPUT,
      fileHash: 'testhash2',
      scenarioIds: IDS,
      nextLabel: `${TAG} two`,
      confirm: `${TAG} one`,
      note: 'eval run 1',
    }),
  });
  if (promoted.status !== 200) throw new Error(`promote failed: ${promoted.text}`);
  madeRounds.push(promoted.json.opened.id);
  ok('owner promotes: batch 1 closes and batch 2 opens in one step');

  const openNow = await db.query(`select id, label from rounds where status = 'open'`);
  if (openNow.rowCount === 1 && openNow.rows[0].id === promoted.json.opened.id) {
    ok('exactly one batch is open, and it is the new one');
  } else {
    bad('one-open invariant', JSON.stringify(openNow.rows));
  }

  const lineage = await db.query('select promoted_from_round_id from rounds where id = $1', [
    promoted.json.opened.id,
  ]);
  if (lineage.rows[0].promoted_from_round_id === opened.json.round.id) {
    ok('batch 2 records which batch its canon came from');
  } else {
    bad('lineage', 'promoted_from_round_id not set');
  }

  // --- Archive fidelity -----------------------------------------------------
  const archived = await db.query(
    `select kind, yaml, sha256 from exports where round_id = $1 order by kind`,
    [opened.json.round.id],
  );
  const inputArchive = archived.rows.find((r) => r.kind === 'input');
  if (inputArchive && inputArchive.yaml === CANON_V2_INPUT && inputArchive.sha256 === sha(CANON_V2_INPUT)) {
    ok('the archived export is byte-identical to what was promoted (eval provenance)');
  } else {
    bad('archive fidelity', 'archived bytes differ from the promoted bytes');
  }

  // --- Batch 2 --------------------------------------------------------------
  console.log('\n--- Batch 2 ---');

  const charlie = await addPerson('Charlie');
  await db.query(`insert into round_participants (round_id, person_id) values ($1,$2), ($1,$3)`, [
    promoted.json.opened.id,
    alpha.id,
    charlie.id,
  ]);

  // Alpha returns using the SAME cookie/link — no reissue between batches.
  const alphaBoot = await asAlpha('/api/bootstrap');
  if (alphaBoot.status === 200 && alphaBoot.json.roundId === promoted.json.opened.id) {
    ok('a returning counselor lands in batch 2 on the same link, no reissue');
  } else {
    bad('returning counselor', `${alphaBoot.status} round=${alphaBoot.json?.roundId}`);
  }

  const canon = await asAlpha('/api/dataset');
  if (canon.json.inputYaml === CANON_V2_INPUT) {
    ok('batch 2 serves the promoted canon, carrying batch 1 corrections');
  } else {
    bad('promoted canon', 'dataset is not the promoted YAML');
  }
  if (canon.json.inputYaml.includes('pause_and_route')) {
    ok("the accepted tier change is present in batch 2's canon");
  } else {
    bad('accepted change', 'expected_tier was not updated');
  }

  // The blind slate: Alpha reviewed t-001 in batch 1, but that does not unlock
  // anyone's batch-2 verdicts.
  await asBravo('/api/session', { method: 'POST', body: JSON.stringify({ token: bravo.token }) });
  const asCharlie = makeClient();
  await asCharlie('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: charlie.token }),
  });
  // Assert the write landed. Without this, the two "nothing leaked" checks
  // below would pass simply because nothing was ever stored.
  await save(asCharlie, 'Charlie', 't-001', 'CHARLIE-BATCH2-SECRET', minutesAgo(10));
  ok("Charlie's batch-2 verdict is stored (so the blind checks below are real)");

  const alphaSees = await asAlpha('/api/overlays');
  if (!alphaSees.text.includes('CHARLIE-BATCH2-SECRET')) {
    ok('a returning counselor starts batch 2 blind — batch-1 work unlocks nothing');
  } else {
    bad('blind slate', "Charlie's batch-2 verdict was visible before Alpha answered");
  }
  if (!alphaSees.text.includes('BATCH1')) {
    ok('batch-1 verdicts do not leak into batch 2');
  } else {
    bad('batch isolation', 'a batch-1 verdict appeared in batch 2');
  }

  await save(asAlpha, 'Alpha', 't-001', 'ALPHA-BATCH2', minutesAgo(5));
  const afterAnswering = await asAlpha('/api/overlays');
  if (afterAnswering.text.includes('CHARLIE-BATCH2-SECRET')) {
    ok("after answering, Charlie's batch-2 verdict becomes visible");
  } else {
    bad('unlock', 'still hidden after answering');
  }

  // Bravo was in batch 1 but not batch 2.
  const bravoBoot = await asBravo('/api/overlays');
  if (bravoBoot.status === 403) {
    ok('a counselor left out of batch 2 is told to wait, not shown an error');
  } else {
    bad('not-enrolled', `expected 403, got ${bravoBoot.status}`);
  }
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  if (madeRounds.length > 0) {
    await db.query('delete from rounds where id = any($1::uuid[])', [madeRounds]);
  }
  if (madePeople.length > 0) {
    await db.query('delete from invites where person_id = any($1::uuid[])', [madePeople]);
    await db.query('delete from people where id = any($1::uuid[])', [madePeople]);
  }
  if (previouslyOpen) {
    await db.query(`update rounds set status = 'open' where id = $1`, [previouslyOpen]);
  }
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Scratch batches removed, live round restored.)`);
process.exit(failed === 0 ? 0 : 1);
