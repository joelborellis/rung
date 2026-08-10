// The stale-rationale warning.
//
// The false positives matter more than the true positive here: a flag that
// fires when nothing is wrong gets ignored within a week, and then it is worth
// less than no flag at all. Most of these tests assert silence.

import { describe, expect, it } from 'vitest';
import { staleRationaleIds } from './merge';
import { resolutionKey, type Resolution, type ReviewOverlay, type ScenarioReview } from '../types/review';
import type { InputScenario, OutputScenario, ScenarioFile } from '../types/scenario';

const JANE = 'jane-uuid';

const inputScenario = (id: string, tier: string): InputScenario => ({
  kind: 'input',
  id,
  category: 'expected_distress',
  description: 'A description.',
  context: { assigned_exercise: 'x', hierarchy_position: 'y', scope_notes: 'z' },
  conversation: [],
  reviewed_by: 'UNREVIEWED',
  expected_tier: tier,
  rationale: 'Distress within the expected range — the mechanism working.',
});

const outputScenario = (id: string, result: boolean): OutputScenario => ({
  kind: 'output',
  id,
  category: 'over_rigidity',
  description: 'A description.',
  context: { assigned_exercise: 'x', hierarchy_position: 'y', scope_notes: 'z' },
  conversation: [],
  reviewed_by: 'UNREVIEWED',
  expected_result: result,
  reason: 'The coach honoured the envelope.',
  feedback: '',
});

const file = (scenarios: Array<InputScenario | OutputScenario>, kind: 'input' | 'output' = 'input'): ScenarioFile => ({
  kind,
  header: '',
  source: '',
  scenarios,
});

function review(scenarioId: string, patch: Partial<ScenarioReview> = {}): ScenarioReview {
  return {
    scenarioId,
    reviewerId: JANE,
    reviewedAt: '2026-08-07T10:00:00.000Z',
    labelVerdict: { kind: 'agree' },
    rationaleVerdict: { kind: 'sound' },
    realismVerdict: { kind: 'realistic' },
    hardCase: false,
    ...patch,
  };
}

const overlay = (reviews: ScenarioReview[]): ReviewOverlay => ({
  reviewer: { id: JANE, displayName: 'Jane Doe' },
  reviews: Object.fromEntries(reviews.map((r) => [r.scenarioId, r])),
  proposals: [],
});

function resolution(
  scenarioId: string,
  concern: Resolution['concern'],
  decision: Resolution['decision'],
  manualValue?: string | boolean,
): Record<string, Resolution> {
  const key = resolutionKey(scenarioId, JANE, concern);
  return {
    [key]: {
      key,
      scenarioId,
      reviewerId: JANE,
      concern,
      decision,
      ...(manualValue !== undefined ? { manualValue } : {}),
      resolvedAt: '2026-08-07T12:00:00.000Z',
    },
  };
}

const changed = (scenarioId: string, proposed: string | boolean) =>
  review(scenarioId, {
    labelVerdict: { kind: 'change', proposed, because: 'Exceeds the therapist envelope.' },
  });

describe('staleRationaleIds — fires when it should', () => {
  it('flags an accepted tier change with no rationale rewrite', () => {
    // The case that motivated this: reviewer moved the tier, called the
    // reasoning sound (it was coherent, just for the wrong answer), so nobody
    // was ever offered the rewrite.
    const scenarios = [inputScenario('s1', 'support_and_continue')];
    const ids = staleRationaleIds(
      file(scenarios),
      [overlay([changed('s1', 'pause_and_route')])],
      resolution('s1', 'label', 'accept'),
    );
    expect([...ids]).toEqual(['s1']);
  });

  it('flags a manual resolution that lands on a different label', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [overlay([changed('s1', 'pause_and_route')])],
      resolution('s1', 'label', 'manual', 'crisis_protocol'),
    );
    expect([...ids]).toEqual(['s1']);
  });

  it('flags an output scenario whose pass/fail moved', () => {
    const ids = staleRationaleIds(
      file([outputScenario('o1', true)], 'output'),
      [overlay([changed('o1', false)])],
      resolution('o1', 'label', 'accept'),
    );
    expect([...ids]).toEqual(['o1']);
  });

  it('flags a rewrite that was proposed but rejected', () => {
    // The prose problem was noticed and then declined — still stale.
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [
        overlay([
          review('s1', {
            labelVerdict: { kind: 'change', proposed: 'pause_and_route', because: 'Exceeds it.' },
            proposedTextEdits: { rationale: 'A better rationale.' },
          }),
        ]),
      ],
      { ...resolution('s1', 'label', 'accept'), ...resolution('s1', 'text', 'keep') },
    );
    expect([...ids]).toEqual(['s1']);
  });
});

describe('staleRationaleIds — stays quiet when it should', () => {
  it('says nothing when nobody proposed a change', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [overlay([review('s1')])],
      {},
    );
    expect(ids.size).toBe(0);
  });

  it('says nothing while a change is still unresolved', () => {
    // Nothing has moved yet; the contested ring is the right signal here, and
    // warning now would fire on every open disagreement.
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [overlay([changed('s1', 'pause_and_route')])],
      {},
    );
    expect(ids.size).toBe(0);
  });

  it('says nothing when the change was declined', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [overlay([changed('s1', 'pause_and_route')])],
      resolution('s1', 'label', 'keep'),
    );
    expect(ids.size).toBe(0);
  });

  it('says nothing when an accepted rewrite accompanies the change', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [
        overlay([
          review('s1', {
            labelVerdict: { kind: 'change', proposed: 'pause_and_route', because: 'Exceeds it.' },
            proposedTextEdits: { rationale: 'Rewritten to match the new tier.' },
          }),
        ]),
      ],
      { ...resolution('s1', 'label', 'accept'), ...resolution('s1', 'text', 'accept') },
    );
    expect(ids.size).toBe(0);
  });

  it('says nothing when the proposed label equals what is already there', () => {
    // A no-op "change" moves nothing, so the prose is still correct.
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'pause_and_route')]),
      [overlay([changed('s1', 'pause_and_route')])],
      resolution('s1', 'label', 'accept'),
    );
    expect(ids.size).toBe(0);
  });

  it('says nothing when a manual resolution lands back on the current label', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [overlay([changed('s1', 'pause_and_route')])],
      resolution('s1', 'label', 'manual', 'support_and_continue'),
    );
    expect(ids.size).toBe(0);
  });

  it('accepts a feedback rewrite as covering an output scenario', () => {
    // For output files the justification a reviewer edits is `feedback`.
    const ids = staleRationaleIds(
      file([outputScenario('o1', true)], 'output'),
      [
        overlay([
          review('o1', {
            labelVerdict: { kind: 'change', proposed: false, because: 'Overrode a valid stop.' },
            proposedTextEdits: { feedback: 'What the corrected response does.' },
          }),
        ]),
      ],
      { ...resolution('o1', 'label', 'accept'), ...resolution('o1', 'text', 'accept') },
    );
    expect(ids.size).toBe(0);
  });

  it('does not count an unrelated description edit as fixing the reasoning', () => {
    const ids = staleRationaleIds(
      file([inputScenario('s1', 'support_and_continue')]),
      [
        overlay([
          review('s1', {
            labelVerdict: { kind: 'change', proposed: 'pause_and_route', because: 'Exceeds it.' },
            proposedTextEdits: { description: 'A tidier summary line.' },
          }),
        ]),
      ],
      { ...resolution('s1', 'label', 'accept'), ...resolution('s1', 'text', 'accept') },
    );
    expect([...ids]).toEqual(['s1']);
  });

  it('handles an empty file and empty overlays', () => {
    expect(staleRationaleIds(file([]), [], {}).size).toBe(0);
    expect(
      staleRationaleIds(file([inputScenario('s1', 'no_issue')]), [], {}).size,
    ).toBe(0);
  });
});
