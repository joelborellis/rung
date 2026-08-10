// The test that protects the whole backend design: an overlay must survive the
// trip through rows unchanged. If this passes, merge.ts / agreement.ts /
// export.ts cannot tell a DB-sourced overlay from a file-sourced one, and the
// merged YAML is byte-identical either way (AC-11).

import { describe, expect, it } from 'vitest';
import type { ReviewOverlay, Reviewer, ScenarioReview } from './review';
import type { FileKind } from './scenario';
import { mergeOverlayInto, overlayToRows, rowsToOverlay } from './overlay';

const REVIEWER: Reviewer = {
  id: '3f1a6d0e-0b2c-4a7d-9f11-8c2e5b7a1d34',
  displayName: 'Jane Doe',
  credentials: 'LPC',
};

const FILE_OF: Record<string, FileKind> = {
  'routine-001': 'input',
  'boundary-002': 'input',
  'crisis-003': 'input',
  'over_rigidity-001': 'output',
  'false_reassurance-002': 'output',
};

const CTX = {
  roundId: 'a0e1c2d3-4444-5555-6666-777788889999',
  fileKindOf: (id: string): FileKind | undefined => FILE_OF[id],
};

/** Every union arm, both optional fields present and absent. */
const OVERLAY: ReviewOverlay = {
  reviewer: REVIEWER,
  reviews: {
    // agree / sound / realistic, no optionals at all
    'routine-001': {
      scenarioId: 'routine-001',
      reviewerId: REVIEWER.id,
      reviewedAt: '2026-08-06T14:22:09.418Z',
      labelVerdict: { kind: 'agree' },
      rationaleVerdict: { kind: 'sound' },
      realismVerdict: { kind: 'realistic' },
      hardCase: false,
    },
    // change to a tier (string label) / flawed / unrealistic, every optional set
    'boundary-002': {
      scenarioId: 'boundary-002',
      reviewerId: REVIEWER.id,
      reviewedAt: '2026-08-06T14:31:52.007Z',
      labelVerdict: {
        kind: 'change',
        proposed: 'pause_and_route',
        because: 'The disclosure exceeds the exposure envelope the therapist set.',
      },
      rationaleVerdict: { kind: 'flawed', because: 'It conflates distress with deterioration.' },
      realismVerdict: { kind: 'unrealistic', because: 'No client phrases it that cleanly.' },
      hardCase: true,
      comment: 'Worth discussing as a group.',
      proposedTextEdits: {
        rationale: 'Rewritten rationale.',
        description: 'Rewritten description.',
      },
    },
    // change to a BOOLEAN label — the output-file case
    'over_rigidity-001': {
      scenarioId: 'over_rigidity-001',
      reviewerId: REVIEWER.id,
      reviewedAt: '2026-08-06T15:02:00.000Z',
      labelVerdict: { kind: 'change', proposed: false, because: 'The coach overrode a valid stop.' },
      rationaleVerdict: { kind: 'sound' },
      realismVerdict: { kind: 'realistic' },
      hardCase: false,
      proposedTextEdits: { feedback: 'Corrected response should honour the stop signal.' },
    },
  },
  proposals: [
    // draft, unassigned
    {
      tempId: 'new-8f14e45f-ceea-467a-9575-28e2e0f2f5b1',
      targetFile: 'input',
      authorId: REVIEWER.id,
      status: 'draft',
      scenario: { category: 'ambiguous_boundary', description: 'Half-written.' },
    },
    // submitted, assigned and accepted by the owner
    {
      tempId: 'new-2c1743a3-91b4-4d0f-8a63-9b0a4c7e5d22',
      targetFile: 'output',
      authorId: REVIEWER.id,
      status: 'submitted',
      scenario: { category: 'false_reassurance', description: 'Reassurance loop.', feedback: 'x' },
      assignedId: 'false_reassurance-007',
      accepted: true,
    },
  ],
};

describe('overlay <-> rows round trip', () => {
  it('survives decomposition and reassembly unchanged', () => {
    const rows = overlayToRows(OVERLAY, CTX);
    expect(rows.unplaced).toEqual([]);
    expect(rowsToOverlay(REVIEWER, rows)).toStrictEqual(OVERLAY);
  });

  it('keeps reviewedAt as the exact original string', () => {
    // merge.ts sorts reviewers by localeCompare on this field and stamps.ts
    // slices its first 10 chars into the YAML. Any reformatting silently
    // changes merge precedence and stamp dates.
    const rows = overlayToRows(OVERLAY, CTX);
    const back = rowsToOverlay(REVIEWER, rows);
    for (const [id, review] of Object.entries(OVERLAY.reviews)) {
      expect(back.reviews[id]?.reviewedAt).toBe(review.reviewedAt);
      expect(typeof back.reviews[id]?.reviewedAt).toBe('string');
    }
  });

  it('keeps a boolean label verdict a boolean', () => {
    // merge.ts applies an accepted label with `=== true` semantics downstream;
    // 'false' as a string would silently stop matching.
    const rows = overlayToRows(OVERLAY, CTX);
    const back = rowsToOverlay(REVIEWER, rows);
    const verdict = back.reviews['over_rigidity-001']?.labelVerdict;
    expect(verdict).toStrictEqual({
      kind: 'change',
      proposed: false,
      because: 'The coach overrode a valid stop.',
    });
    expect(typeof (verdict as { proposed: unknown }).proposed).toBe('boolean');
  });

  it('does not invent keys for absent optional fields', () => {
    const rows = overlayToRows(OVERLAY, CTX);
    const back = rowsToOverlay(REVIEWER, rows);
    expect('comment' in back.reviews['routine-001']!).toBe(false);
    expect('proposedTextEdits' in back.reviews['routine-001']!).toBe(false);
    expect('assignedId' in back.proposals[0]!).toBe(false);
    expect('accepted' in back.proposals[0]!).toBe(false);
  });

  it('reports verdicts it cannot place in a file rather than dropping them silently', () => {
    const orphan: ReviewOverlay = {
      ...OVERLAY,
      reviews: {
        'ghost-999': {
          scenarioId: 'ghost-999',
          reviewerId: REVIEWER.id,
          reviewedAt: '2026-08-06T16:00:00.000Z',
          labelVerdict: { kind: 'agree' },
          rationaleVerdict: { kind: 'sound' },
          realismVerdict: { kind: 'realistic' },
          hardCase: false,
        },
      },
    };
    expect(overlayToRows(orphan, CTX).unplaced).toEqual(['ghost-999']);
  });
});

function reviewAt(scenarioId: string, reviewedAt: string, because: string): ScenarioReview {
  return {
    scenarioId,
    reviewerId: REVIEWER.id,
    reviewedAt,
    labelVerdict: { kind: 'change', proposed: 'crisis_protocol', because },
    rationaleVerdict: { kind: 'sound' },
    realismVerdict: { kind: 'realistic' },
    hardCase: false,
  };
}

describe('mergeOverlayInto', () => {
  const base: ReviewOverlay = {
    reviewer: REVIEWER,
    reviews: { 'routine-001': reviewAt('routine-001', '2026-08-06T12:00:00.000Z', 'local newer') },
    proposals: [],
  };

  it('keeps the newer verdict when the incoming one is older', () => {
    // The old importOverlay spread incoming over existing unconditionally, so
    // re-importing a stale file silently reverted newer local work.
    const stale: ReviewOverlay = {
      reviewer: REVIEWER,
      reviews: { 'routine-001': reviewAt('routine-001', '2026-08-05T09:00:00.000Z', 'stale') },
      proposals: [],
    };
    const merged = mergeOverlayInto(base, stale);
    expect((merged.reviews['routine-001']!.labelVerdict as { because: string }).because).toBe(
      'local newer',
    );
  });

  it('takes the incoming verdict when it is newer', () => {
    const fresh: ReviewOverlay = {
      reviewer: REVIEWER,
      reviews: { 'routine-001': reviewAt('routine-001', '2026-08-07T09:00:00.000Z', 'fresher') },
      proposals: [],
    };
    expect(
      (mergeOverlayInto(base, fresh).reviews['routine-001']!.labelVerdict as { because: string })
        .because,
    ).toBe('fresher');
  });

  it('is idempotent — re-importing the same file changes nothing', () => {
    expect(mergeOverlayInto(base, base)).toStrictEqual(base);
  });

  it('adds scenarios the existing overlay has never seen', () => {
    const other: ReviewOverlay = {
      reviewer: REVIEWER,
      reviews: { 'crisis-003': reviewAt('crisis-003', '2026-08-04T09:00:00.000Z', 'new id') },
      proposals: [],
    };
    const merged = mergeOverlayInto(base, other);
    expect(Object.keys(merged.reviews).sort()).toEqual(['crisis-003', 'routine-001']);
  });

  it('returns the incoming overlay untouched when there is nothing to merge into', () => {
    expect(mergeOverlayInto(undefined, base)).toStrictEqual(base);
  });

  it('replaces a proposal with the same tempId and keeps the rest', () => {
    const withProposals: ReviewOverlay = { ...base, proposals: OVERLAY.proposals };
    const incoming: ReviewOverlay = {
      ...base,
      proposals: [{ ...OVERLAY.proposals[1]!, accepted: false }],
    };
    const merged = mergeOverlayInto(withProposals, incoming);
    expect(merged.proposals).toHaveLength(2);
    expect(merged.proposals.find((p) => p.tempId === OVERLAY.proposals[1]!.tempId)?.accepted).toBe(
      false,
    );
  });
});
