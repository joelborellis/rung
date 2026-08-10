// Folding a pull into local state.
//
// The case that matters most: a poll landing between "save" and "drain" must
// not overwrite the verdict the reviewer just entered with the server's older
// copy. That is the bug that makes people stop trusting sync.

import { describe, expect, it } from 'vitest';
import type { ReviewOverlay, ScenarioReview } from '../types/review';
import { applyPull } from './pull';

const ME = 'me-uuid';
const THEM = 'them-uuid';

const review = (scenarioId: string, reviewedAt: string, because: string): ScenarioReview => ({
  scenarioId,
  reviewerId: ME,
  reviewedAt,
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const overlay = (id: string, reviews: Record<string, ScenarioReview>): ReviewOverlay => ({
  reviewer: { id, displayName: id === ME ? 'Me' : 'Them' },
  reviews,
  proposals: [],
});

const because = (o: ReviewOverlay, s: string) =>
  (o.reviews[s]!.labelVerdict as { because: string }).because;

describe('applyPull', () => {
  it('adds another reviewer wholesale', () => {
    const next = applyPull({
      existing: {},
      incoming: [overlay(THEM, { a: review('a', '2026-08-06T12:00:00.000Z', 'theirs') })],
      selfId: ME,
      pending: new Set(),
    });
    expect(Object.keys(next)).toEqual([THEM]);
  });

  it('replaces another reviewer rather than merging — the server owns them', () => {
    const existing = { [THEM]: overlay(THEM, { a: review('a', '2026-08-06T12:00:00.000Z', 'old') }) };
    const next = applyPull({
      existing,
      incoming: [overlay(THEM, { b: review('b', '2026-08-06T13:00:00.000Z', 'new') })],
      selfId: ME,
      pending: new Set(),
    });
    // A verdict they withdrew must disappear locally too.
    expect(Object.keys(next[THEM]!.reviews)).toEqual(['b']);
  });

  it('merges the local reviewer by timestamp rather than replacing', () => {
    const existing = {
      [ME]: overlay(ME, { a: review('a', '2026-08-06T14:00:00.000Z', 'newer local') }),
    };
    const next = applyPull({
      existing,
      incoming: [overlay(ME, { a: review('a', '2026-08-06T12:00:00.000Z', 'older server') })],
      selfId: ME,
      pending: new Set(),
    });
    expect(because(next[ME]!, 'a')).toBe('newer local');
  });

  it('takes the server copy when it is genuinely newer — the other device', () => {
    const existing = {
      [ME]: overlay(ME, { a: review('a', '2026-08-06T12:00:00.000Z', 'this device') }),
    };
    const next = applyPull({
      existing,
      incoming: [overlay(ME, { a: review('a', '2026-08-07T09:00:00.000Z', 'other device') })],
      selfId: ME,
      pending: new Set(),
    });
    expect(because(next[ME]!, 'a')).toBe('other device');
  });

  it('never touches a scenario with an unsent local write', () => {
    // The race: save at 14:00, poll arrives before the drain. Even though the
    // server's copy looks newer by clock, it predates the local edit.
    const existing = {
      [ME]: overlay(ME, { a: review('a', '2026-08-06T14:00:00.000Z', 'just typed') }),
    };
    const next = applyPull({
      existing,
      incoming: [overlay(ME, { a: review('a', '2026-08-08T09:00:00.000Z', 'server wins?') })],
      selfId: ME,
      pending: new Set(['a']),
    });
    expect(because(next[ME]!, 'a')).toBe('just typed');
  });

  it('still applies other scenarios while one is pending', () => {
    const existing = {
      [ME]: overlay(ME, { a: review('a', '2026-08-06T14:00:00.000Z', 'pending') }),
    };
    const next = applyPull({
      existing,
      incoming: [
        overlay(ME, {
          a: review('a', '2026-08-08T09:00:00.000Z', 'ignored'),
          b: review('b', '2026-08-08T09:00:00.000Z', 'applied'),
        }),
      ],
      selfId: ME,
      pending: new Set(['a']),
    });
    expect(because(next[ME]!, 'a')).toBe('pending');
    expect(because(next[ME]!, 'b')).toBe('applied');
  });

  it('keeps local scenarios the server did not mention (delta pull)', () => {
    // With ?since=, a pull carries only what changed. Everything else must
    // survive untouched.
    const existing = {
      [ME]: overlay(ME, {
        a: review('a', '2026-08-06T12:00:00.000Z', 'unchanged'),
        b: review('b', '2026-08-06T12:00:00.000Z', 'also unchanged'),
      }),
    };
    const next = applyPull({
      existing,
      incoming: [overlay(ME, { c: review('c', '2026-08-06T13:00:00.000Z', 'new') })],
      selfId: ME,
      pending: new Set(),
    });
    expect(Object.keys(next[ME]!.reviews).sort()).toEqual(['a', 'b', 'c']);
  });

  it('leaves reviewers the pull did not mention alone', () => {
    const existing = { [THEM]: overlay(THEM, { a: review('a', '2026-08-06T12:00:00.000Z', 'x') }) };
    const next = applyPull({ existing, incoming: [], selfId: ME, pending: new Set() });
    expect(next).toEqual(existing);
  });

  it('treats an unknown self id as another reviewer rather than crashing', () => {
    const next = applyPull({
      existing: {},
      incoming: [overlay(ME, { a: review('a', '2026-08-06T12:00:00.000Z', 'x') })],
      selfId: null,
      pending: new Set(),
    });
    expect(Object.keys(next)).toEqual([ME]);
  });
});
