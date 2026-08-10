// Input validation. Two things are being protected here: the client cannot
// claim to be someone else, and a malformed verdict becomes a 400 naming the
// field rather than a 500 with a Postgres message.

import { describe, expect, it } from 'vitest';
import { ApiError } from './http';
import { parseProposal, parseResolution, parseScenarioReview, parseStringArray } from './validate';

const ME = '3f1a6d0e-0b2c-4a7d-9f11-8c2e5b7a1d34';
const THEM = 'ffffffff-0000-0000-0000-000000000000';

const agree = {
  scenarioId: 'routine-001',
  reviewedAt: '2026-08-06T14:22:09.418Z',
  labelVerdict: { kind: 'agree' },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
};

describe('parseScenarioReview', () => {
  it('accepts the agree path', () => {
    expect(parseScenarioReview(agree, ME)).toStrictEqual({ ...agree, reviewerId: ME });
  });

  it('overwrites a spoofed reviewerId with the session owner', () => {
    // The attack: post a verdict attributed to another clinician.
    const review = parseScenarioReview({ ...agree, reviewerId: THEM }, ME);
    expect(review.reviewerId).toBe(ME);
  });

  it('keeps a change verdict with a real reason', () => {
    const review = parseScenarioReview(
      {
        ...agree,
        labelVerdict: {
          kind: 'change',
          proposed: 'pause_and_route',
          because: 'Exceeds the therapist envelope.',
        },
      },
      ME,
    );
    expect(review.labelVerdict).toStrictEqual({
      kind: 'change',
      proposed: 'pause_and_route',
      because: 'Exceeds the therapist envelope.',
    });
  });

  it('keeps a boolean proposed label a boolean', () => {
    const review = parseScenarioReview(
      { ...agree, labelVerdict: { kind: 'change', proposed: false, because: 'Overrode a stop.' } },
      ME,
    );
    expect((review.labelVerdict as { proposed: unknown }).proposed).toBe(false);
  });

  it('rejects a change verdict with a too-short reason (AC-3, server side)', () => {
    expect(() =>
      parseScenarioReview(
        { ...agree, labelVerdict: { kind: 'change', proposed: 'crisis_protocol', because: 'no' } },
        ME,
      ),
    ).toThrow(/at least 10 characters/);
  });

  it.each([
    ['unknown label kind', { labelVerdict: { kind: 'maybe' } }],
    ['unknown rationale kind', { rationaleVerdict: { kind: 'ok' } }],
    ['unknown realism kind', { realismVerdict: { kind: 'meh' } }],
    ['missing scenarioId', { scenarioId: '' }],
    ['non-ISO reviewedAt', { reviewedAt: 'yesterday' }],
    ['null label verdict', { labelVerdict: null }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseScenarioReview({ ...agree, ...patch }, ME)).toThrow(ApiError);
  });

  it('rejects a clock more than a day ahead', () => {
    // Last-write-wins uses this timestamp; a runaway clock would win forever.
    const future = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString();
    expect(() => parseScenarioReview({ ...agree, reviewedAt: future }, ME)).toThrow(/clock/i);
  });

  it('accepts a clock slightly ahead — ordinary drift is not an error', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(parseScenarioReview({ ...agree, reviewedAt: soon }, ME).reviewedAt).toBe(soon);
  });

  it('drops an empty comment rather than storing one', () => {
    expect('comment' in parseScenarioReview({ ...agree, comment: '' }, ME)).toBe(false);
  });

  it('keeps only the three known text-edit fields', () => {
    const review = parseScenarioReview(
      { ...agree, proposedTextEdits: { rationale: 'r', nonsense: 'x' } },
      ME,
    );
    expect(review.proposedTextEdits).toStrictEqual({ rationale: 'r' });
  });

  it('treats a missing hardCase as false rather than failing', () => {
    const { hardCase, ...withoutFlag } = agree;
    expect(parseScenarioReview(withoutFlag, ME).hardCase).toBe(false);
  });
});

describe('parseProposal', () => {
  const draft = {
    tempId: 'new-abc',
    targetFile: 'input',
    status: 'draft',
    scenario: { description: 'Half-written.' },
  };

  it('accepts a draft and forces authorship to the session', () => {
    const proposal = parseProposal({ ...draft, authorId: THEM }, ME, { allowOwnerFields: false });
    expect(proposal.authorId).toBe(ME);
  });

  it('refuses owner-only fields from a reviewer', () => {
    // Otherwise re-saving a draft would clear the owner's id assignment.
    expect(() =>
      parseProposal({ ...draft, assignedId: 'rigidity-042' }, ME, { allowOwnerFields: false }),
    ).toThrow(/only the project owner/i);
    expect(() =>
      parseProposal({ ...draft, accepted: true }, ME, { allowOwnerFields: false }),
    ).toThrow(/only the project owner/i);
  });

  it('allows them from the owner', () => {
    const proposal = parseProposal({ ...draft, assignedId: 'rigidity-042', accepted: true }, ME, {
      allowOwnerFields: true,
    });
    expect(proposal.assignedId).toBe('rigidity-042');
    expect(proposal.accepted).toBe(true);
  });

  it.each([
    ['bad targetFile', { targetFile: 'sideways' }],
    ['bad status', { status: 'finished' }],
    ['missing tempId', { tempId: '' }],
    ['scenario not an object', { scenario: 'text' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseProposal({ ...draft, ...patch }, ME, { allowOwnerFields: false })).toThrow(
      ApiError,
    );
  });
});

describe('parseResolution', () => {
  const keep = {
    scenarioId: 'routine-001',
    reviewerId: THEM,
    concern: 'label',
    decision: 'keep',
    resolvedAt: '2026-08-06T16:00:00.000Z',
  };

  it('accepts a keep decision with no value', () => {
    expect(parseResolution(keep).decision).toBe('keep');
  });

  it('requires a value for a manual decision', () => {
    expect(() => parseResolution({ ...keep, decision: 'manual' })).toThrow(/manualValue/);
  });

  it('preserves a boolean manualValue (merge.ts compares === true)', () => {
    const resolution = parseResolution({ ...keep, decision: 'manual', manualValue: true });
    expect(resolution.manualValue).toBe(true);
    expect(typeof resolution.manualValue).toBe('boolean');
  });

  it('keeps the referenced reviewerId — a resolution is about someone else', () => {
    // Unlike a review, this field is not the caller's identity.
    expect(parseResolution(keep).reviewerId).toBe(THEM);
  });

  it.each([
    ['bad concern', { concern: 'vibes' }],
    ['bad decision', { decision: 'maybe' }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseResolution({ ...keep, ...patch })).toThrow(ApiError);
  });
});

describe('parseStringArray', () => {
  it('defaults to empty', () => {
    expect(parseStringArray(undefined, 'deletes')).toEqual([]);
  });

  it('accepts strings and rejects anything else', () => {
    expect(parseStringArray(['a', 'b'], 'deletes')).toEqual(['a', 'b']);
    expect(() => parseStringArray('a', 'deletes')).toThrow(ApiError);
    expect(() => parseStringArray([1], 'deletes')).toThrow(ApiError);
  });
});
