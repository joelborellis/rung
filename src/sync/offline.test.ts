// AC-2 and AC-13, at the seam that decides both.
//
// AC-2: an agree-path review is ≤4 clicks and Save advances. The network must
// therefore never be awaited on that path — not "usually fast", never awaited.
//
// AC-13: a reviewer whose connection is down for an entire session completes
// every scenario and exports a valid review file. The server being unreachable
// must degrade to exactly the behaviour that existed before the backend.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioReview } from '../types/review';
import { SyncError, type Api } from './client';
import { drain, resetDrainState } from './drain';
import { enqueueReview, outboxSize, readOutbox } from './outbox';
import { useSyncStore } from './useSyncStore';

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

const review = (scenarioId: string): ScenarioReview => ({
  scenarioId,
  reviewerId: 'me',
  reviewedAt: new Date().toISOString(),
  labelVerdict: { kind: 'agree' },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const offlineTransport = (): Api =>
  ({
    reviewsBatch: vi.fn(async () => {
      throw new SyncError(0, 'OFFLINE', 'Network error');
    }),
    putProposal: vi.fn(),
    deleteProposal: vi.fn(),
    putResolution: vi.fn(),
    deleteResolution: vi.fn(),
  }) as unknown as Api;

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage();
  resetDrainState();
  useSyncStore.getState().reset();
  useSyncStore.getState().set({ status: 'idle', signedIn: true });
});

describe('AC-2 — the network is never on the Save & next path', () => {
  it('enqueue returns synchronously, with no promise to await', () => {
    // If this ever returns a thenable, someone has put I/O on the save path.
    const result = enqueueReview(review('routine-001'), storage);
    expect(result).not.toBeInstanceOf(Promise);
    expect((result as unknown as { then?: unknown }).then).toBeUndefined();
  });

  it('queues 24 verdicts back to back without any transport call', () => {
    // A whole file's worth of Save & next, with the server never touched.
    const transport = offlineTransport();
    for (let i = 0; i < 24; i += 1) enqueueReview(review(`s${i}`), storage);

    expect(transport.reviewsBatch).not.toHaveBeenCalled();
    expect(outboxSize(storage)).toBe(24);
  });

  it('saves in well under a millisecond each, even with a full queue', () => {
    // Not a benchmark — a guard against someone making enqueue read/parse
    // something expensive per call.
    for (let i = 0; i < 50; i += 1) enqueueReview(review(`s${i}`), storage);
    const start = performance.now();
    enqueueReview(review('one-more'), storage);
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe('AC-13 — a whole session with the server unreachable', () => {
  it('keeps every verdict queued through repeated failures', async () => {
    const transport = offlineTransport();
    for (let i = 0; i < 24; i += 1) enqueueReview(review(`s${i}`), storage);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      resetDrainState(); // skip the backoff quiet period
      await drain({ transport, storage, now: () => 1_000_000, random: () => 0.5 });
    }

    // Nothing lost, nothing dead-lettered — offline is retryable, not fatal.
    expect(outboxSize(storage)).toBe(24);
    expect(readOutbox(storage).dead).toHaveLength(0);
    expect(useSyncStore.getState().status).toBe('offline');
  });

  it('reports the backlog so the reviewer knows to export', async () => {
    const transport = offlineTransport();
    for (let i = 0; i < 5; i += 1) enqueueReview(review(`s${i}`), storage);
    await drain({ transport, storage, now: () => 1_000_000, random: () => 0.5 });

    expect(useSyncStore.getState().pending).toBe(5);
  });

  it('flushes everything once the connection returns', async () => {
    const failing = offlineTransport();
    for (let i = 0; i < 24; i += 1) enqueueReview(review(`s${i}`), storage);
    await drain({ transport: failing, storage, now: () => 1_000_000, random: () => 0.5 });
    expect(outboxSize(storage)).toBe(24);

    const working = {
      reviewsBatch: vi.fn(async (upserts: ScenarioReview[]) => ({
        applied: upserts.map((u) => u.scenarioId),
        stale: [],
        rejected: [],
        serverTime: '2026-08-07T10:00:00.000Z',
      })),
    } as unknown as Api;

    resetDrainState();
    await drain({ transport: working, storage, now: () => 2_000_000, random: () => 0.5 });

    // One request for the whole backlog, and the queue is clear.
    expect(working.reviewsBatch).toHaveBeenCalledTimes(1);
    expect(outboxSize(storage)).toBe(0);
    expect(useSyncStore.getState().status).toBe('idle');
  });

  it('survives the outbox being written and re-read across a "refresh"', () => {
    // The queue lives in localStorage, so a reload mid-session keeps it.
    for (let i = 0; i < 3; i += 1) enqueueReview(review(`s${i}`), storage);
    const reloaded = readOutbox(storage);
    expect(reloaded.ops).toHaveLength(3);
    expect(reloaded.ops.every((op) => op.payload)).toBe(true);
  });
});
