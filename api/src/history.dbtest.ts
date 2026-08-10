// The conflict-history trigger.
//
// Policy is last-write-wins, which means one of a counselor's two answers is
// discarded. This keeps the discarded one, so an overwrite is visible rather
// than silent. A trigger nobody has watched fire is worth less than no
// trigger, hence these.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { INSERT_REVIEW_SQL, insertReviewParams } from './mappers';
import type { ReviewRow } from '../../shared/overlay';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
afterAll(async () => {
  await client.end();
});

async function seed() {
  const round = await client.query<{ id: string }>(
    `insert into rounds (label, status) values ('history', 'closed') returning id`,
  );
  const person = await client.query<{ id: string }>(
    `insert into people (email, display_name) values ($1, 'Hist Ory') returning id`,
    [`history-${randomUUID()}@example.com`],
  );
  await client.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
    round.rows[0]!.id,
    person.rows[0]!.id,
  ]);
  return { roundId: round.rows[0]!.id, personId: person.rows[0]!.id };
}

const row = (
  roundId: string,
  personId: string,
  reviewedAt: string,
  because: string,
): ReviewRow => ({
  roundId,
  personId,
  scenarioId: 'routine-001',
  fileKind: 'input',
  reviewedAtIso: reviewedAt,
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
  comment: null,
  proposedTextEdits: null,
});

const history = (roundId: string) =>
  client.query<{ reason: string; snapshot: { label_verdict: { because: string } } }>(
    'select reason, snapshot from review_history where round_id = $1 order by id',
    [roundId],
  );

beforeEach(async () => {
  await client.query('begin');
  return async () => {
    await client.query('rollback');
  };
});

describe('review_history', () => {
  it('keeps the verdict an overwrite replaced', async () => {
    const { roundId, personId } = await seed();
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(row(roundId, personId, '2026-08-07T10:00:00.000Z', 'FIRST-ANSWER')),
    );
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(row(roundId, personId, '2026-08-07T11:00:00.000Z', 'SECOND-ANSWER')),
    );

    const past = await history(roundId);
    expect(past.rowCount).toBe(1);
    expect(past.rows[0]!.reason).toBe('overwrite');
    expect(past.rows[0]!.snapshot.label_verdict.because).toBe('FIRST-ANSWER');
  });

  it('does not record a replay as history', async () => {
    // The outbox retries and sendBeacon both re-send identical writes. Logging
    // those would bury the real overwrites in noise.
    const { roundId, personId } = await seed();
    const same = row(roundId, personId, '2026-08-07T10:00:00.000Z', 'ONLY-ANSWER');
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(same));
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(same));
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(same));

    expect((await history(roundId)).rowCount).toBe(0);
  });

  it('records nothing when a stale write is refused', async () => {
    // The WHERE clause suppresses the update entirely, so there is no
    // overwrite to log — the stored answer never changed.
    const { roundId, personId } = await seed();
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(row(roundId, personId, '2026-08-07T10:00:00.000Z', 'CURRENT')),
    );
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(row(roundId, personId, '2026-08-01T10:00:00.000Z', 'STALE')),
    );

    expect((await history(roundId)).rowCount).toBe(0);
  });

  it('keeps a verdict that was deleted', async () => {
    const { roundId, personId } = await seed();
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(row(roundId, personId, '2026-08-07T10:00:00.000Z', 'BEFORE-DELETE')),
    );
    await client.query(
      'delete from reviews where round_id = $1 and person_id = $2 and scenario_id = $3',
      [roundId, personId, 'routine-001'],
    );

    const past = await history(roundId);
    expect(past.rowCount).toBe(1);
    expect(past.rows[0]!.reason).toBe('delete');
    expect(past.rows[0]!.snapshot.label_verdict.because).toBe('BEFORE-DELETE');
  });

  it('records a changed comment even when the verdicts match', async () => {
    const { roundId, personId } = await seed();
    const base = row(roundId, personId, '2026-08-07T10:00:00.000Z', 'SAME');
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(base));
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams({
        ...base,
        reviewedAtIso: '2026-08-07T11:00:00.000Z',
        comment: 'On reflection, discuss this one.',
      }),
    );

    expect((await history(roundId)).rowCount).toBe(1);
  });
});
