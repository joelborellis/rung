// AC-11: merged YAML produced from database-sourced overlays must be
// byte-identical to merged YAML produced from localStorage-sourced ones.
//
// This is the acceptance criterion for the entire backend. Everything else —
// the mappers, the blind filter, the sync layer — exists to make an overlay
// survive a round trip. If the bytes coming out the far end differ by so much
// as a line ending, the database has become a second model of review semantics
// rather than a transport for the first, and §3 is quietly broken.
//
// Deliberately run against the REAL canon and the REAL export path, not a
// fixture: the line-span patcher's behaviour depends on the actual formatting
// of the two hand-maintained YAML files.

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

import { exportMergedYaml } from './export';
import { parseScenarioFile } from './yaml/parse';
import { overlayToRows } from '../../shared/overlay';
import { resolutionKey, type Resolution, type ReviewOverlay } from '../../shared/review';
import type { FileKind, ScenarioFile } from '../../shared/scenario';
import {
  INSERT_REVIEW_SQL,
  insertReviewParams,
  toOverlay,
  type DbPersonRow,
  type DbProposalRow,
  type DbReviewRow,
} from '../../api/src/mappers';

const ROOT = resolve(process.cwd());
const inputText = readFileSync(resolve(ROOT, 'data/input_tier_scenarios.yaml'), 'utf8');
const outputText = readFileSync(resolve(ROOT, 'data/output_behavior_scenarios.yaml'), 'utf8');

const inputFile = parseScenarioFile(inputText, 'input').file;
const outputFile = parseScenarioFile(outputText, 'output').file;

const fileOf = new Map<string, FileKind>();
for (const s of inputFile.scenarios) fileOf.set(s.id, 'input');
for (const s of outputFile.scenarios) fileOf.set(s.id, 'output');

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
afterAll(async () => {
  await client.end();
});

async function seedPerson(): Promise<DbPersonRow> {
  const row = await client.query<DbPersonRow>(
    `insert into people (email, display_name, credentials)
     values ($1, 'Jane Doe', 'LPC')
     returning id, email, display_name, credentials, role`,
    [`parity-${randomUUID()}@example.com`],
  );
  return row.rows[0]!;
}

async function seedRound(personId: string): Promise<string> {
  // Closed, so it never competes for the single open-round slot.
  const round = await client.query<{ id: string }>(
    `insert into rounds (label, status) values ('parity', 'closed') returning id`,
  );
  const roundId = round.rows[0]!.id;
  await client.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
    roundId,
    personId,
  ]);
  return roundId;
}

/** Push an overlay through Postgres and reassemble it. */
async function throughDatabase(
  overlay: ReviewOverlay,
  person: DbPersonRow,
  roundId: string,
): Promise<ReviewOverlay> {
  const rows = overlayToRows(overlay, { roundId, fileKindOf: (id) => fileOf.get(id) });
  expect(rows.unplaced).toEqual([]);

  for (const row of rows.reviews) {
    await client.query(INSERT_REVIEW_SQL, insertReviewParams(row));
  }

  const back = await client.query<DbReviewRow>(
    `select round_id, person_id, scenario_id, file_kind, reviewed_at_iso,
            label_verdict, rationale_verdict, realism_verdict,
            hard_case, comment, proposed_text_edits
       from reviews where round_id = $1 and person_id = $2 order by scenario_id`,
    [roundId, person.id],
  );
  const proposals = await client.query<DbProposalRow>(
    `select round_id, author_id, temp_id, target_file, status, scenario, assigned_id, accepted
       from proposals where round_id = $1 and author_id = $2 order by temp_id`,
    [roundId, person.id],
  );
  return toOverlay(person, back.rows, proposals.rows);
}

function exportBoth(
  file: ScenarioFile,
  overlays: ReviewOverlay[],
  resolutions: Record<string, Resolution> = {},
): string {
  // `now` is pinned: the stamp carries a date, and a test that straddles
  // midnight would otherwise fail for a reason that has nothing to do with
  // the database.
  return exportMergedYaml({ file, overlays, resolutions, now: '2026-08-07T12:00:00.000Z' });
}

beforeEach(async () => {
  await client.query('begin');
  return async () => {
    await client.query('rollback');
  };
});

describe('AC-11 — export parity between local and database overlays', () => {
  it('produces byte-identical YAML for a mixed overlay', async () => {
    const person = await seedPerson();
    const roundId = await seedRound(person.id);
    const reviewer = { id: person.id, displayName: 'Jane Doe', credentials: 'LPC' };

    const [first, second, third] = inputFile.scenarios;
    const local: ReviewOverlay = {
      reviewer,
      reviews: {
        [first!.id]: {
          scenarioId: first!.id,
          reviewerId: person.id,
          reviewedAt: '2026-08-07T09:00:00.000Z',
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
        [second!.id]: {
          scenarioId: second!.id,
          reviewerId: person.id,
          reviewedAt: '2026-08-07T09:05:00.000Z',
          labelVerdict: {
            kind: 'change',
            proposed: 'pause_and_route',
            because: 'The disclosure exceeds the therapist envelope.',
          },
          rationaleVerdict: { kind: 'flawed', because: 'It conflates distress with deterioration.' },
          realismVerdict: { kind: 'unrealistic', because: 'No client phrases it that cleanly.' },
          hardCase: true,
          comment: 'Worth discussing as a group.',
        },
        [third!.id]: {
          scenarioId: third!.id,
          reviewerId: person.id,
          reviewedAt: '2026-08-07T09:10:00.000Z',
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
          proposedTextEdits: { rationale: 'A clearer rationale.', description: 'A clearer summary.' },
        },
      },
      proposals: [],
    };

    const fromDb = await throughDatabase(local, person, roundId);
    expect(exportBoth(inputFile, [fromDb])).toBe(exportBoth(inputFile, [local]));
  });

  it('stays identical once the owner has resolved a contested label', async () => {
    // The resolution path is where a change verdict finally moves the canon.
    // If the DB round trip altered manualValue's type or the reviewer id, the
    // resolution would stop matching and the label would silently not apply.
    const person = await seedPerson();
    const roundId = await seedRound(person.id);
    const reviewer = { id: person.id, displayName: 'Jane Doe', credentials: 'LPC' };
    const target = inputFile.scenarios[1]!;

    const local: ReviewOverlay = {
      reviewer,
      reviews: {
        [target.id]: {
          scenarioId: target.id,
          reviewerId: person.id,
          reviewedAt: '2026-08-07T09:05:00.000Z',
          labelVerdict: { kind: 'change', proposed: 'crisis_protocol', because: 'Safety risk implied.' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
      },
      proposals: [],
    };

    const resolutions: Record<string, Resolution> = {
      [resolutionKey(target.id, person.id, 'label')]: {
        key: resolutionKey(target.id, person.id, 'label'),
        scenarioId: target.id,
        reviewerId: person.id,
        concern: 'label',
        decision: 'accept',
        resolvedAt: '2026-08-07T11:00:00.000Z',
      },
    };

    const fromDb = await throughDatabase(local, person, roundId);
    const a = exportBoth(inputFile, [local], resolutions);
    const b = exportBoth(inputFile, [fromDb], resolutions);

    expect(b).toBe(a);
    // And the accepted label actually landed, so this is not parity between
    // two no-ops.
    expect(a).toContain('crisis_protocol');
  });

  it('is identical for the output file, where labels are booleans', async () => {
    const person = await seedPerson();
    const roundId = await seedRound(person.id);
    const reviewer = { id: person.id, displayName: 'Jane Doe', credentials: 'LPC' };
    const target = outputFile.scenarios[0]!;

    const local: ReviewOverlay = {
      reviewer,
      reviews: {
        [target.id]: {
          scenarioId: target.id,
          reviewerId: person.id,
          reviewedAt: '2026-08-07T09:00:00.000Z',
          labelVerdict: { kind: 'change', proposed: false, because: 'The coach overrode a stop.' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
          proposedTextEdits: { feedback: 'Corrected response honours the stop signal.' },
        },
      },
      proposals: [],
    };

    const fromDb = await throughDatabase(local, person, roundId);
    expect(exportBoth(outputFile, [fromDb])).toBe(exportBoth(outputFile, [local]));
  });

  it('an empty overlay from the database still exports the file unchanged (AC-5)', async () => {
    const person = await seedPerson();
    await seedRound(person.id);
    const empty: ReviewOverlay = {
      reviewer: { id: person.id, displayName: 'Jane Doe', credentials: 'LPC' },
      reviews: {},
      proposals: [],
    };
    // Nothing was reviewed, so the export must be the original bytes.
    expect(exportBoth(inputFile, [empty])).toBe(inputFile.source);
  });

  it('keeps parity across two reviewers, where merge order matters', async () => {
    // mergeFile sorts entries by reviewedAt with localeCompare. If the DB
    // reformatted that string, the stamps would come out in a different order
    // and the bytes would diverge.
    const a = await seedPerson();
    const b = await seedPerson();
    const roundId = await seedRound(a.id);
    await client.query(`insert into round_participants (round_id, person_id) values ($1,$2)`, [
      roundId,
      b.id,
    ]);
    const target = inputFile.scenarios[0]!;

    const make = (person: DbPersonRow, at: string, name: string): ReviewOverlay => ({
      reviewer: { id: person.id, displayName: name, credentials: 'LPC' },
      reviews: {
        [target.id]: {
          scenarioId: target.id,
          reviewerId: person.id,
          reviewedAt: at,
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
      },
      proposals: [],
    });

    const localA = make(a, '2026-08-07T09:00:00.000Z', 'Alice Brown');
    const localB = make(b, '2026-08-07T09:30:00.000Z', 'Bob Clark');

    const dbA = await throughDatabase(localA, { ...a, display_name: 'Alice Brown' }, roundId);
    const dbB = await throughDatabase(localB, { ...b, display_name: 'Bob Clark' }, roundId);

    const fromLocal = exportBoth(inputFile, [localA, localB]);
    expect(exportBoth(inputFile, [dbA, dbB])).toBe(fromLocal);
    // Both stamps present, in reviewedAt order.
    expect(fromLocal.indexOf('AB')).toBeLessThan(fromLocal.indexOf('BC'));
  });
});
