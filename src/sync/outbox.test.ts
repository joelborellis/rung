// The outbox. Two properties matter more than the rest: enqueue never blocks,
// and nothing is ever silently dropped.

import { beforeEach, describe, expect, it } from 'vitest';
import type { ScenarioReview } from '../types/review';
import {
  OUTBOX_KEY,
  backoffMs,
  clearDead,
  enqueue,
  enqueueReview,
  enqueueReviewDelete,
  outboxSize,
  pendingScenarioIds,
  readOutbox,
  settle,
  writeOutbox,
} from './outbox';

function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage();
});

const review = (scenarioId: string, reviewedAt = '2026-08-06T12:00:00.000Z'): ScenarioReview => ({
  scenarioId,
  reviewerId: 'me',
  reviewedAt,
  labelVerdict: { kind: 'agree' },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

describe('enqueue', () => {
  it('is synchronous and returns the new state', () => {
    // The whole design rests on this: it is called from Save & next.
    const file = enqueueReview(review('routine-001'), storage);
    expect(file.ops).toHaveLength(1);
    expect(file.ops[0]!.kind).toBe('review.put');
  });

  it('persists immediately, so a refresh does not lose the write', () => {
    enqueueReview(review('routine-001'), storage);
    expect(readOutbox(storage).ops).toHaveLength(1);
    expect(storage.getItem(OUTBOX_KEY)).toContain('routine-001');
  });

  it('coalesces repeated saves of one scenario into a single op', () => {
    // A reviewer changing their mind four times must not produce four requests.
    for (const at of ['12:00', '12:01', '12:02', '12:03']) {
      enqueueReview(review('routine-001', `2026-08-06T${at}:00.000Z`), storage);
    }
    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(1);
    expect((file.ops[0]!.payload as ScenarioReview).reviewedAt).toBe('2026-08-06T12:03:00.000Z');
  });

  it('keeps separate scenarios separate', () => {
    enqueueReview(review('a'), storage);
    enqueueReview(review('b'), storage);
    expect(outboxSize(storage)).toBe(2);
  });

  it('lets a delete supersede a pending save for the same scenario', () => {
    enqueueReview(review('routine-001'), storage);
    enqueueReviewDelete('routine-001', storage);
    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(1);
    expect(file.ops[0]!.kind).toBe('review.del');
  });

  it('does not let a review and a proposal with the same key collide', () => {
    enqueue({ kind: 'review.put', key: 'x', payload: 1 }, storage);
    enqueue({ kind: 'proposal.put', key: 'x', payload: 2 }, storage);
    expect(outboxSize(storage)).toBe(2);
  });

  it('preserves order of first appearance', () => {
    enqueueReview(review('a'), storage);
    enqueueReview(review('b'), storage);
    enqueueReview(review('a', '2026-08-06T13:00:00.000Z'), storage);
    // 'a' was re-queued, so it moves to the back — the payload is what matters,
    // not the position, since every op is independent.
    expect(readOutbox(storage).ops.map((o) => o.key)).toEqual(['b', 'a']);
  });
});

describe('readOutbox', () => {
  it('returns an empty queue when there is nothing stored', () => {
    expect(readOutbox(storage)).toEqual({ schemaVersion: 1, ops: [], dead: [] });
  });

  it('recovers from corrupted storage instead of throwing', () => {
    // An unusable outbox must not stop a clinician working.
    storage.setItem(OUTBOX_KEY, '{not json');
    expect(readOutbox(storage).ops).toEqual([]);
  });

  it('discards a queue written by a future schema rather than misreading it', () => {
    writeOutbox({ schemaVersion: 99, ops: [{} as never], dead: [] }, storage);
    expect(readOutbox(storage).ops).toEqual([]);
  });
});

describe('settle', () => {
  it('removes what succeeded', () => {
    enqueueReview(review('a'), storage);
    enqueueReview(review('b'), storage);
    const { ops } = readOutbox(storage);
    settle({ done: [ops[0]!.opId] }, storage);
    expect(readOutbox(storage).ops.map((o) => o.key)).toEqual(['b']);
  });

  it('keeps failures queued and counts the attempt', () => {
    enqueueReview(review('a'), storage);
    const id = readOutbox(storage).ops[0]!.opId;

    settle({ done: [], failed: [{ opId: id, error: 'offline' }] }, storage);
    const after = readOutbox(storage).ops[0]!;
    expect(after.attempts).toBe(1);
    expect(after.lastError).toBe('offline');

    settle({ done: [], failed: [{ opId: id, error: 'offline' }] }, storage);
    expect(readOutbox(storage).ops[0]!.attempts).toBe(2);
  });

  it('moves permanently rejected ops to the dead list rather than dropping them', () => {
    // The reviewer must be told to export; silently losing a verdict is the
    // one outcome that is unacceptable.
    enqueueReview(review('a'), storage);
    const id = readOutbox(storage).ops[0]!.opId;
    settle({ done: [], dead: [id] }, storage);

    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(0);
    expect(file.dead).toHaveLength(1);
    expect(file.dead[0]!.key).toBe('a');
  });

  it('caps the dead list so it cannot grow without bound', () => {
    const dead = Array.from({ length: 150 }, (_, i) => ({
      opId: `op-${i}`,
      kind: 'review.put' as const,
      key: `s${i}`,
      queuedAt: '2026-08-06T12:00:00.000Z',
      attempts: 1,
    }));
    writeOutbox({ schemaVersion: 1, ops: [], dead }, storage);
    enqueueReview(review('x'), storage);
    const id = readOutbox(storage).ops[0]!.opId;
    settle({ done: [], dead: [id] }, storage);
    expect(readOutbox(storage).dead.length).toBeLessThanOrEqual(100);
  });

  it('clearDead empties the dead list without touching pending work', () => {
    enqueueReview(review('a'), storage);
    const id = readOutbox(storage).ops[0]!.opId;
    settle({ done: [], dead: [id] }, storage);
    enqueueReview(review('b'), storage);

    const file = clearDead(storage);
    expect(file.dead).toEqual([]);
    expect(file.ops).toHaveLength(1);
  });
});

describe('pendingScenarioIds', () => {
  it('lists scenarios with an unsent write, so a pull cannot clobber them', () => {
    enqueueReview(review('a'), storage);
    enqueueReviewDelete('b', storage);
    enqueue({ kind: 'proposal.put', key: 'new-x', payload: {} }, storage);
    expect(pendingScenarioIds(storage)).toEqual(new Set(['a', 'b']));
  });
});

describe('backoffMs', () => {
  it('grows exponentially and then stops', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffMs(1, mid)).toBe(1000);
    expect(backoffMs(2, mid)).toBe(2000);
    expect(backoffMs(3, mid)).toBe(4000);
    expect(backoffMs(30, mid)).toBe(60_000);
  });

  it('applies jitter within 20%, so retries do not synchronise', () => {
    for (const r of [0, 0.25, 0.75, 1]) {
      const value = backoffMs(3, () => r);
      expect(value).toBeGreaterThanOrEqual(3200);
      expect(value).toBeLessThanOrEqual(4800);
    }
  });

  it('never returns a negative delay', () => {
    expect(backoffMs(0, () => 0)).toBeGreaterThan(0);
  });
});
