// The leverage-point test, against real Postgres.
//
// If an overlay survives a trip through the database byte-for-byte, then
// merge.ts, agreement.ts, and export.ts cannot tell a DB-sourced overlay from
// one parsed out of a .review.json — which is what makes AC-11 (byte-identical
// merged YAML from either source) achievable, and what keeps the database a
// transport rather than a second model of review semantics.
//
// Every test runs in a transaction that is rolled back, so this is safe to
// point at a live database.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { ReviewOverlay } from '../../shared/review';
import { overlayToRows } from '../../shared/overlay';
import type { FileKind } from '../../shared/scenario';
import {
  INSERT_REVIEW_SQL,
  UPSERT_PROPOSAL_SQL,
  insertReviewParams,
  toOverlay,
  upsertProposalParams,
  type DbPersonRow,
  type DbProposalRow,
  type DbReviewRow,
} from './mappers';

const FILE_OF: Record<string, FileKind> = {
  'routine-001': 'input',
  'boundary-002': 'input',
  'over_rigidity-001': 'output',
};
const fileKindOf = (id: string) => FILE_OF[id];

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

afterAll(async () => {
  await client.end();
});

/**
 * A round, an enrolled person, and their identity row.
 *
 * The round is created `closed` on purpose: `rounds_one_open` allows exactly
 * one open round, and a seeded database already has one. Nothing here depends
 * on the round being open — these tests exercise storage, not enrollment
 * gating — so taking the open slot would only make the suite fail whenever it
 * runs against a real workspace.
 *
 * The email is unique per call for the same reason: the suite must not assume
 * it owns the database.
 */
async function seed(): Promise<{ roundId: string; person: DbPersonRow }> {
  const round = await client.query(
    `insert into rounds (label, status) values ('roundtrip test', 'closed') returning id`,
  );
  const roundId = round.rows[0].id as string;
  const person = await client.query(
    `insert into people (email, display_name, credentials)
     values ($1, 'Jane Doe', 'LPC')
     returning id, email, display_name, credentials, role`,
    [`roundtrip-${randomUUID()}@example.com`],
  );
  await client.query(
    `insert into round_participants (round_id, person_id) values ($1, $2)`,
    [roundId, person.rows[0].id],
  );
  return { roundId, person: person.rows[0] as DbPersonRow };
}

async function readBack(roundId: string, person: DbPersonRow): Promise<ReviewOverlay> {
  const reviews = await client.query<DbReviewRow>(
    `select round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
            label_verdict, rationale_verdict, realism_verdict,
            hard_case, comment, proposed_text_edits
       from reviews where round_id = $1 and person_id = $2
       order by scenario_id`,
    [roundId, person.id],
  );
  const proposals = await client.query<DbProposalRow>(
    `select round_id, author_id, temp_id, target_file, status, scenario, assigned_id, accepted
       from proposals where round_id = $1 and author_id = $2
       order by temp_id`,
    [roundId, person.id],
  );
  return toOverlay(person, reviews.rows, proposals.rows);
}

beforeEach(async () => {
  await client.query('begin');
  return async () => {
    await client.query('rollback');
  };
});

describe('ReviewOverlay round trip through Postgres', () => {
  it('comes back structurally identical', async () => {
    const { roundId, person } = await seed();

    const original: ReviewOverlay = {
      reviewer: { id: person.id, displayName: 'Jane Doe', credentials: 'LPC' },
      reviews: {
        'routine-001': {
          scenarioId: 'routine-001',
          reviewerId: person.id,
          reviewedAt: '2026-08-06T14:22:09.418Z',
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
        'boundary-002': {
          scenarioId: 'boundary-002',
          reviewerId: person.id,
          reviewedAt: '2026-08-06T14:31:52.007Z',
          labelVerdict: {
            kind: 'change',
            proposed: 'pause_and_route',
            because: 'Exceeds the therapist envelope.',
          },
          rationaleVerdict: { kind: 'flawed', because: 'Conflates distress with deterioration.' },
          realismVerdict: { kind: 'unrealistic', because: 'Nobody phrases it that cleanly.' },
          hardCase: true,
          comment: 'Discuss as a group.',
          proposedTextEdits: { rationale: 'Rewritten.', description: 'Also rewritten.' },
        },
        'over_rigidity-001': {
          scenarioId: 'over_rigidity-001',
          reviewerId: person.id,
          reviewedAt: '2026-08-06T15:02:00.000Z',
          labelVerdict: { kind: 'change', proposed: false, because: 'Overrode a valid stop.' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
      },
      proposals: [
        {
          tempId: 'new-aaaa',
          targetFile: 'input',
          authorId: person.id,
          status: 'draft',
          scenario: { category: 'ambiguous_boundary', description: 'Half-written.' },
        },
      ],
    };

    const rows = overlayToRows(original, { roundId, fileKindOf });
    expect(rows.unplaced).toEqual([]);
    for (const row of rows.reviews) {
      await client.query(INSERT_REVIEW_SQL, insertReviewParams(row));
    }
    for (const row of rows.proposals) {
      await client.query(UPSERT_PROPOSAL_SQL, upsertProposalParams(row));
    }

    expect(await readBack(roundId, person)).toStrictEqual(original);
  });

  it('preserves reviewedAt as the exact string, not a re-formatted date', async () => {
    // merge.ts orders reviewers by localeCompare on this and stamps.ts slices
    // its first 10 characters into the YAML. A Date round trip would rewrite
    // it and silently change both.
    const { roundId, person } = await seed();
    const odd = '2026-08-06T14:22:09.418Z';
    const overlay: ReviewOverlay = {
      reviewer: { id: person.id, displayName: 'Jane Doe' },
      reviews: {
        'routine-001': {
          scenarioId: 'routine-001',
          reviewerId: person.id,
          reviewedAt: odd,
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
      },
      proposals: [],
    };
    const rows = overlayToRows(overlay, { roundId, fileKindOf });
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(rows.reviews[0]!));

    const back = await readBack(roundId, person);
    expect(back.reviews['routine-001']!.reviewedAt).toBe(odd);
  });
});

describe('the upsert conflict policy mirrors mergeOverlayInto', () => {
  const review = (roundId: string, personId: string, reviewedAt: string, because: string) => ({
    roundId,
    personId,
    scenarioId: 'routine-001',
    fileKind: 'input' as FileKind,
    reviewedAtIso: reviewedAt,
    labelVerdict: { kind: 'change' as const, proposed: 'crisis_protocol', because },
    rationaleVerdict: { kind: 'sound' as const },
    realismVerdict: { kind: 'realistic' as const },
    hardCase: false,
    comment: null,
    proposedTextEdits: null,
  });

  it('accepts a newer verdict', async () => {
    const { roundId, person } = await seed();
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(review(roundId, person.id, '2026-08-06T12:00:00.000Z', 'first')),
    );
    const result = await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(review(roundId, person.id, '2026-08-07T12:00:00.000Z', 'newer')),
    );
    expect(result.rowCount).toBe(1);

    const back = await readBack(roundId, person);
    expect((back.reviews['routine-001']!.labelVerdict as { because: string }).because).toBe('newer');
  });

  it('rejects a stale verdict from a second device', async () => {
    // The bug this prevents: a laptop that was offline syncs yesterday's
    // answer and silently reverts today's.
    const { roundId, person } = await seed();
    await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(review(roundId, person.id, '2026-08-06T12:00:00.000Z', 'current')),
    );
    const result = await client.query(
      INSERT_REVIEW_SQL,
      insertReviewParams(review(roundId, person.id, '2026-08-05T12:00:00.000Z', 'stale')),
    );
    expect(result.rowCount).toBe(0); // the WHERE clause suppressed the update

    const back = await readBack(roundId, person);
    expect((back.reviews['routine-001']!.labelVerdict as { because: string }).because).toBe(
      'current',
    );
  });

  it('is idempotent — replaying the same write is not an error', async () => {
    const { roundId, person } = await seed();
    const row = review(roundId, person.id, '2026-08-06T12:00:00.000Z', 'same');
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(row));
    const result = await client.query(INSERT_REVIEW_SQL, insertReviewParams(row));
    expect(result.rowCount).toBe(1);
  });
});
