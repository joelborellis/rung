// Does the schema actually enforce what the comments claim? Every assertion
// here corresponds to a real bug the constraint exists to prevent.
//
// Destructive: runs inside a transaction that is always rolled back, so it is
// safe against a live database. Run with `node db/smoke.mjs`.

import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl } from './env.mjs';

/** Unique per run: this suite must not assume it owns the database. */
const email = (name) => `smoke-${name}-${randomUUID()}@example.com`;
const JANE = email('jane');
const JOEL = email('joel');

let passed = 0;
let failed = 0;

function ok(label) {
  passed += 1;
  console.log(`  PASS  ${label}`);
}
function bad(label, detail) {
  failed += 1;
  console.log(`  FAIL  ${label}\n        ${detail}`);
}

/** Assert a statement is rejected, and by the constraint we expect. */
async function rejects(client, label, sql, params, expect) {
  await client.query('savepoint s');
  try {
    await client.query(sql, params);
    await client.query('rollback to savepoint s');
    bad(label, 'statement was ACCEPTED but should have been rejected');
  } catch (error) {
    await client.query('rollback to savepoint s');
    const text = `${error.constraint ?? ''} ${error.message}`;
    if (text.includes(expect)) ok(label);
    else bad(label, `rejected, but not by ${expect}: ${error.message}`);
  }
}

async function accepts(client, label, sql, params) {
  try {
    const result = await client.query(sql, params);
    ok(label);
    return result;
  } catch (error) {
    bad(label, error.message);
    throw error;
  }
}

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();
await client.query('begin');

try {
  // A seeded workspace already has an open round, and rounds_one_open allows
  // exactly one. Close it inside the transaction so the round assertions below
  // start from a known state; the rollback puts it back.
  await client.query(`update rounds set status = 'closed' where status = 'open'`);

  console.log('\nIdentity');

  const person = await accepts(
    client,
    'accepts a lowercase email',
    `insert into people (email, display_name, credentials)
     values ($1, 'Jane Doe', 'LPC') returning id`,
    [JANE],
  );
  const personId = person.rows[0].id;

  const owner = await client.query(
    `insert into people (email, display_name, role) values ($1, 'Joel B', 'owner') returning id`,
    [JOEL],
  );
  const ownerId = owner.rows[0].id;

  await rejects(
    client,
    'rejects a mixed-case email (would split one counselor into two identities)',
    `insert into people (email, display_name) values ('Jane@Example.com', 'Jane Again')`,
    [],
    'people_email_check',
  );
  await rejects(
    client,
    'rejects a duplicate email',
    `insert into people (email, display_name) values ($1, 'Impostor')`,
    [JANE],
    'people_email_key',
  );
  await rejects(
    client,
    'rejects a string that is not an email',
    `insert into people (email, display_name) values ('notanemail', 'Nobody')`,
    [],
    'people_email_check',
  );

  console.log('\nRounds — batches are strictly sequential');

  const r1 = await client.query(
    `insert into rounds (label) values ('Batch 1') returning id`,
  );
  const roundId = r1.rows[0].id;
  ok('accepts the first open round');

  await rejects(
    client,
    'rejects a second open round',
    `insert into rounds (label) values ('Batch 2')`,
    [],
    'rounds_one_open',
  );

  await client.query(`update rounds set status = 'closed' where id = $1`, [roundId]);
  await accepts(
    client,
    'accepts a second round once the first is closed',
    `insert into rounds (label, promoted_from_round_id) values ('Batch 2', $1)`,
    [roundId],
  );
  await client.query(`delete from rounds where label = 'Batch 2'`);
  await client.query(`update rounds set status = 'open' where id = $1`, [roundId]);

  console.log('\nEnrollment gates verdicts');

  const review = (pid) => [
    roundId,
    pid,
    'routine-001',
    'input',
    '2026-08-06T14:22:09.418Z',
    '2026-08-06T14:22:09.418Z',
    JSON.stringify({ kind: 'agree' }),
    JSON.stringify({ kind: 'sound' }),
    JSON.stringify({ kind: 'realistic' }),
  ];
  const INSERT_REVIEW = `
    insert into reviews (round_id, person_id, scenario_id, file_kind,
                         reviewed_at_iso, reviewed_at,
                         label_verdict, rationale_verdict, realism_verdict)
    values ($1,$2,$3,$4,$5,$6::timestamptz,$7::jsonb,$8::jsonb,$9::jsonb)`;

  await rejects(
    client,
    'rejects a verdict from someone not enrolled in the round',
    INSERT_REVIEW,
    review(personId),
    'reviews_round_id_person_id_fkey',
  );

  await client.query(
    `insert into round_participants (round_id, person_id, joined_at)
     values ($1, $2, now()), ($1, $3, now())`,
    [roundId, personId, ownerId],
  );
  await accepts(client, 'accepts it once enrolled', INSERT_REVIEW, review(personId));

  await rejects(
    client,
    'rejects two verdicts from one person on one scenario',
    INSERT_REVIEW,
    review(personId),
    'reviews_round_id_person_id_scenario_id_key',
  );

  await rejects(
    client,
    'rejects a verdict kind outside the Verdict<T> union',
    INSERT_REVIEW,
    [
      roundId,
      ownerId,
      'routine-002',
      'input',
      '2026-08-06T14:22:09.418Z',
      '2026-08-06T14:22:09.418Z',
      JSON.stringify({ kind: 'maybe' }),
      JSON.stringify({ kind: 'sound' }),
      JSON.stringify({ kind: 'realistic' }),
    ],
    'reviews_shape',
  );

  console.log('\njsonb keeps its types');

  await client.query(INSERT_REVIEW, [
    roundId,
    ownerId,
    'over_rigidity-001',
    'output',
    '2026-08-06T15:02:00.000Z',
    '2026-08-06T15:02:00.000Z',
    JSON.stringify({ kind: 'change', proposed: false, because: 'Overrode a valid stop.' }),
    JSON.stringify({ kind: 'sound' }),
    JSON.stringify({ kind: 'realistic' }),
  ]);
  const back = await client.query(
    `select label_verdict, reviewed_at_iso, label_kind from reviews
      where round_id = $1 and scenario_id = 'over_rigidity-001'`,
    [roundId],
  );
  const verdict = back.rows[0].label_verdict;
  if (verdict.proposed === false && typeof verdict.proposed === 'boolean') {
    ok('a boolean label verdict comes back a boolean, not the string "false"');
  } else {
    bad('boolean label verdict', `got ${JSON.stringify(verdict.proposed)}`);
  }
  if (back.rows[0].reviewed_at_iso === '2026-08-06T15:02:00.000Z') {
    ok('reviewed_at_iso is the verbatim client string (merge order + stamp dates)');
  } else {
    bad('reviewed_at_iso', `got ${back.rows[0].reviewed_at_iso}`);
  }
  if (back.rows[0].label_kind === 'change') {
    ok('the generated label_kind column tracks the jsonb');
  } else {
    bad('label_kind', `got ${back.rows[0].label_kind}`);
  }

  console.log('\nProposals — id assignment cannot collide');

  await client.query(
    `insert into proposals (round_id, author_id, temp_id, target_file, status, scenario, assigned_id)
     values ($1, $2, 'new-aaa', 'input', 'submitted', '{}'::jsonb, 'rigidity-042')`,
    [roundId, personId],
  );
  ok('accepts the first claim on an assigned id');

  await rejects(
    client,
    'rejects a second counselor claiming the same assigned id',
    `insert into proposals (round_id, author_id, temp_id, target_file, status, scenario, assigned_id)
     values ($1, $2, 'new-bbb', 'input', 'submitted', '{}'::jsonb, 'rigidity-042')`,
    [roundId, ownerId],
    'proposals_assigned_id_unique',
  );

  await accepts(
    client,
    'allows many unassigned drafts (partial index ignores nulls)',
    `insert into proposals (round_id, author_id, temp_id, target_file, status, scenario)
     values ($1, $2, 'new-ccc', 'input', 'draft', '{}'::jsonb),
            ($1, $2, 'new-ddd', 'input', 'draft', '{}'::jsonb)`,
    [roundId, ownerId],
  );

  console.log('\nResolutions');

  await rejects(
    client,
    "rejects decision 'manual' with no value",
    `insert into resolutions (round_id, scenario_id, person_id, concern, decision, resolved_at_iso)
     values ($1, 'routine-001', $2, 'label', 'manual', '2026-08-06T16:00:00.000Z')`,
    [roundId, personId],
    'manual_needs_value',
  );

  await client.query(
    `insert into resolutions (round_id, scenario_id, person_id, concern, decision, manual_value, resolved_at_iso)
     values ($1, 'routine-001', $2, 'label', 'manual', 'true'::jsonb, '2026-08-06T16:00:00.000Z')`,
    [roundId, personId],
  );
  const mv = await client.query(
    `select manual_value from resolutions where round_id = $1 and scenario_id = 'routine-001'`,
    [roundId],
  );
  if (mv.rows[0].manual_value === true) {
    ok('manualValue survives as a boolean (merge.ts compares it with === true)');
  } else {
    bad('manual_value', `got ${JSON.stringify(mv.rows[0].manual_value)}`);
  }
} finally {
  await client.query('rollback');
  await client.end();
}

console.log(`\n${passed} passed, ${failed} failed. (All changes rolled back.)`);
process.exit(failed === 0 ? 0 : 1);
