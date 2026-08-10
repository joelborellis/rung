// Pure mapper tests — no database. The DB-backed round trip lives in
// db/roundtrip.mjs; this pins the shape conversion itself.

import { describe, expect, it } from 'vitest';
import type { DbPersonRow, DbResolutionRow, DbReviewRow } from './mappers';
import {
  insertReviewParams,
  toOverlay,
  toResolution,
  toReviewer,
  toReviewRow,
} from './mappers';

const PERSON: DbPersonRow = {
  id: '3f1a6d0e-0b2c-4a7d-9f11-8c2e5b7a1d34',
  email: 'jane@example.com',
  display_name: 'Jane Doe',
  credentials: 'LPC',
  role: 'reviewer',
};

const ROW: DbReviewRow = {
  round_id: 'a0e1c2d3-4444-5555-6666-777788889999',
  person_id: PERSON.id,
  scenario_id: 'boundary-002',
  file_kind: 'input',
  reviewed_at_iso: '2026-08-06T14:31:52.007Z',
  label_verdict: { kind: 'change', proposed: 'pause_and_route', because: 'Exceeds the envelope.' },
  rationale_verdict: { kind: 'flawed', because: 'Conflates distress with deterioration.' },
  realism_verdict: { kind: 'realistic' },
  hard_case: true,
  comment: 'Discuss as a group.',
  proposed_text_edits: { rationale: 'Rewritten.' },
};

describe('toReviewer', () => {
  it('never leaks the email — identity stays server-side', () => {
    const reviewer = toReviewer(PERSON);
    expect(JSON.stringify(reviewer)).not.toContain('jane@example.com');
    expect(reviewer).toStrictEqual({ id: PERSON.id, displayName: 'Jane Doe', credentials: 'LPC' });
  });

  it('omits credentials rather than sending null', () => {
    expect(toReviewer({ ...PERSON, credentials: null })).toStrictEqual({
      id: PERSON.id,
      displayName: 'Jane Doe',
    });
  });
});

describe('toReviewRow', () => {
  it('carries reviewed_at_iso through as the exact string', () => {
    expect(toReviewRow(ROW).reviewedAtIso).toBe('2026-08-06T14:31:52.007Z');
  });

  it('keeps a boolean label verdict a boolean', () => {
    const row = toReviewRow({
      ...ROW,
      label_verdict: { kind: 'change', proposed: false, because: 'Overrode a valid stop.' },
    });
    expect((row.labelVerdict as { proposed: unknown }).proposed).toBe(false);
  });
});

describe('toOverlay', () => {
  it('produces a ReviewOverlay indistinguishable from a parsed .review.json', () => {
    const overlay = toOverlay(
      PERSON,
      [ROW],
      [
        {
          round_id: ROW.round_id,
          author_id: PERSON.id,
          temp_id: 'new-8f14e45f',
          target_file: 'output',
          status: 'submitted',
          scenario: { category: 'false_reassurance', description: 'Loop.' },
          assigned_id: 'false_reassurance-007',
          accepted: true,
        },
      ],
    );

    expect(overlay).toStrictEqual({
      reviewer: { id: PERSON.id, displayName: 'Jane Doe', credentials: 'LPC' },
      reviews: {
        'boundary-002': {
          scenarioId: 'boundary-002',
          reviewerId: PERSON.id,
          reviewedAt: '2026-08-06T14:31:52.007Z',
          labelVerdict: ROW.label_verdict,
          rationaleVerdict: ROW.rationale_verdict,
          realismVerdict: ROW.realism_verdict,
          hardCase: true,
          comment: 'Discuss as a group.',
          proposedTextEdits: { rationale: 'Rewritten.' },
        },
      },
      proposals: [
        {
          tempId: 'new-8f14e45f',
          targetFile: 'output',
          authorId: PERSON.id,
          status: 'submitted',
          scenario: { category: 'false_reassurance', description: 'Loop.' },
          assignedId: 'false_reassurance-007',
          accepted: true,
        },
      ],
    });
  });

  it('turns NULL columns back into absent keys, not nulls', () => {
    const overlay = toOverlay(
      PERSON,
      [{ ...ROW, comment: null, proposed_text_edits: null }],
      [],
    );
    const review = overlay.reviews['boundary-002']!;
    expect('comment' in review).toBe(false);
    expect('proposedTextEdits' in review).toBe(false);
  });
});

describe('toResolution', () => {
  const base: DbResolutionRow = {
    scenario_id: 'routine-001',
    person_id: PERSON.id,
    concern: 'label',
    decision: 'manual',
    manual_value: true,
    resolved_at_iso: '2026-08-06T16:00:00.000Z',
  };

  it('rebuilds the composite key from its parts', () => {
    expect(toResolution(base).key).toBe(`routine-001::${PERSON.id}::label`);
  });

  it('keeps a boolean manualValue boolean (merge.ts compares === true)', () => {
    expect(toResolution(base).manualValue).toBe(true);
    expect(typeof toResolution(base).manualValue).toBe('boolean');
  });

  it('omits manualValue when there is none', () => {
    expect('manualValue' in toResolution({ ...base, decision: 'keep', manual_value: null })).toBe(
      false,
    );
  });
});

describe('insertReviewParams', () => {
  it('serialises jsonb columns and passes the iso string untouched', () => {
    const params = insertReviewParams(toReviewRow(ROW));
    expect(params[4]).toBe('2026-08-06T14:31:52.007Z');
    expect(params[5]).toBe(JSON.stringify(ROW.label_verdict));
    expect(params[8]).toBe(true); // hard_case
    expect(params[10]).toBe(JSON.stringify(ROW.proposed_text_edits));
  });

  it('passes null rather than the string "null" for absent jsonb', () => {
    const params = insertReviewParams(toReviewRow({ ...ROW, proposed_text_edits: null }));
    expect(params[10]).toBeNull();
  });
});
