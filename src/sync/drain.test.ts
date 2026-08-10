// The drain loop, with an injected transport. No server, no network.
//
// The scenarios here are the ones that decide whether a clinician loses work:
// offline, a session that ended mid-batch, a verdict the server refuses, and
// two drains racing.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioReview } from '../types/review';
import { SyncError, type Api, type BatchResult } from './client';
import { drain, resetDrainState } from './drain';
import { enqueueProposal, enqueueReview, outboxSize, readOutbox } from './outbox';
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
  reviewedAt: '2026-08-06T12:00:00.000Z',
  labelVerdict: { kind: 'agree' },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const okBatch = (applied: string[]): BatchResult => ({
  applied,
  stale: [],
  rejected: [],
  serverTime: '2026-08-06T12:00:01.000Z',
});

function transport(overrides: Partial<Api> = {}): Api {
  return {
    reviewsBatch: vi.fn(async (upserts: ScenarioReview[], deletes: string[]) =>
      okBatch([...upserts.map((u) => u.scenarioId), ...deletes]),
    ),
    putProposal: vi.fn(async (p) => ({ tempId: p.tempId })),
    deleteProposal: vi.fn(async () => undefined),
    putResolution: vi.fn(async (r) => ({ key: r.key })),
    deleteResolution: vi.fn(async () => undefined),
    signIn: vi.fn(),
    session: vi.fn(),
    signOut: vi.fn(),
    bootstrap: vi.fn(),
    dataset: vi.fn(),
    overlays: vi.fn(),
    ...overrides,
  } as unknown as Api;
}

let storage: Storage;
const deps = (t: Api) => ({ transport: t, storage, now: () => 1_000_000, random: () => 0.5 });

beforeEach(() => {
  vi.useFakeTimers();
  storage = fakeStorage();
  resetDrainState();
  useSyncStore.getState().reset();
  useSyncStore.getState().set({ status: 'idle', signedIn: true });
});

describe('a successful drain', () => {
  it('sends queued reviews as one batch and empties the queue', () => {
    // Three verdicts, one request.
    enqueueReview(review('a'), storage);
    enqueueReview(review('b'), storage);
    enqueueReview(review('c'), storage);

    const t = transport();
    return drain(deps(t)).then(() => {
      expect(t.reviewsBatch).toHaveBeenCalledTimes(1);
      expect(outboxSize(storage)).toBe(0);
      expect(useSyncStore.getState().status).toBe('idle');
      expect(useSyncStore.getState().pending).toBe(0);
    });
  });

  it('records when the sync last succeeded', async () => {
    enqueueReview(review('a'), storage);
    await drain(deps(transport()));
    expect(useSyncStore.getState().lastSyncedAt).toBe(new Date(1_000_000).toISOString());
  });

  it('retires an op the server reports as stale — newer data already there', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async () => ({
        applied: [],
        stale: ['a'],
        rejected: [],
        serverTime: 'x',
      })),
    });
    enqueueReview(review('a'), storage);
    await drain(deps(t));
    // Nothing to do and nothing wrong: not an error, and not left queued.
    expect(outboxSize(storage)).toBe(0);
    expect(useSyncStore.getState().status).toBe('idle');
  });

  it('does nothing at all when the queue is empty', async () => {
    const t = transport();
    await drain(deps(t));
    expect(t.reviewsBatch).not.toHaveBeenCalled();
  });

  it('stays quiet in local (no server) mode', async () => {
    useSyncStore.getState().set({ status: 'local' });
    enqueueReview(review('a'), storage);
    const t = transport();
    await drain(deps(t));
    expect(t.reviewsBatch).not.toHaveBeenCalled();
    expect(outboxSize(storage)).toBe(1);
  });
});

describe('offline', () => {
  it('keeps the work queued and reports offline', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async () => {
        throw new SyncError(0, 'OFFLINE', 'Network error');
      }),
    });
    enqueueReview(review('a'), storage);
    await drain(deps(t));

    expect(outboxSize(storage)).toBe(1);
    const state = useSyncStore.getState();
    expect(state.status).toBe('offline');
    expect(state.pending).toBe(1);
  });

  it('counts attempts so backoff can grow', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async () => {
        throw new SyncError(0, 'OFFLINE', 'Network error');
      }),
    });
    enqueueReview(review('a'), storage);

    await drain(deps(t));
    expect(readOutbox(storage).ops[0]!.attempts).toBe(1);

    // Backoff has set a quiet period; jump past it.
    resetDrainState();
    await drain(deps(t));
    expect(readOutbox(storage).ops[0]!.attempts).toBe(2);
  });

  it('retries a 500, because the next attempt may work', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async () => {
        throw new SyncError(500, 'INTERNAL', 'Server error');
      }),
    });
    enqueueReview(review('a'), storage);
    await drain(deps(t));
    expect(outboxSize(storage)).toBe(1);
    expect(useSyncStore.getState().status).toBe('offline');
  });
});

describe('a session that ended', () => {
  it('keeps the queue and asks the reviewer to reconnect', async () => {
    // Dropping the queue here would lose real work.
    const t = transport({
      reviewsBatch: vi.fn(async () => {
        throw new SyncError(401, 'UNAUTHENTICATED', 'Session ended');
      }),
    });
    enqueueReview(review('a'), storage);
    await drain(deps(t));

    expect(outboxSize(storage)).toBe(1);
    const state = useSyncStore.getState();
    expect(state.status).toBe('signed-out');
    expect(state.signedIn).toBe(false);
    expect(state.lastError).toMatch(/review link/i);
  });

  it('stops sending the rest of the queue once the session is gone', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async () => {
        throw new SyncError(401, 'UNAUTHENTICATED', 'Session ended');
      }),
    });
    enqueueReview(review('a'), storage);
    enqueueProposal(
      { tempId: 'new-x', targetFile: 'input', authorId: 'me', status: 'draft', scenario: {} },
      storage,
    );
    await drain(deps(t));
    expect(t.putProposal).not.toHaveBeenCalled();
  });
});

describe('work the server refuses', () => {
  it('dead-letters a rejected verdict instead of retrying forever', async () => {
    // A 400 fails identically every time; retrying hides it in a busy loop.
    const t = transport({
      reviewsBatch: vi.fn(async () => ({
        applied: [],
        stale: [],
        rejected: [{ scenarioId: 'a', code: 'INVALID', message: 'Because is too short.' }],
        serverTime: 'x',
      })),
    });
    enqueueReview(review('a'), storage);
    await drain(deps(t));

    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(0);
    expect(file.dead).toHaveLength(1);
    expect(useSyncStore.getState().dead).toHaveLength(1);
    expect(useSyncStore.getState().lastError).toMatch(/couldn't be saved/i);
  });

  it('dead-letters a 400 on a proposal but keeps going', async () => {
    const t = transport({
      putProposal: vi.fn(async () => {
        throw new SyncError(400, 'BAD_FIELD', 'targetFile is wrong');
      }),
    });
    enqueueReview(review('a'), storage);
    enqueueProposal(
      { tempId: 'new-x', targetFile: 'input', authorId: 'me', status: 'draft', scenario: {} },
      storage,
    );
    await drain(deps(t));

    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(0); // review sent, proposal dead-lettered
    expect(file.dead.map((op) => op.key)).toEqual(['new-x']);
  });

  it('applies the good verdicts in a batch that also contains a bad one', async () => {
    const t = transport({
      reviewsBatch: vi.fn(async (upserts: ScenarioReview[]) => ({
        applied: upserts.filter((u) => u.scenarioId !== 'bad').map((u) => u.scenarioId),
        stale: [],
        rejected: [{ scenarioId: 'bad', code: 'INVALID', message: 'nope' }],
        serverTime: 'x',
      })),
    });
    enqueueReview(review('good'), storage);
    enqueueReview(review('bad'), storage);
    await drain(deps(t));

    const file = readOutbox(storage);
    expect(file.ops).toHaveLength(0);
    expect(file.dead.map((op) => op.key)).toEqual(['bad']);
  });
});

describe('concurrency', () => {
  it('two simultaneous drains share one run rather than double-sending', async () => {
    let resolve!: (value: BatchResult) => void;
    const t = transport({
      reviewsBatch: vi.fn(() => new Promise<BatchResult>((r) => (resolve = r))),
    });
    enqueueReview(review('a'), storage);

    const first = drain(deps(t));
    const second = drain(deps(t));
    resolve(okBatch(['a']));
    await Promise.all([first, second]);

    expect(t.reviewsBatch).toHaveBeenCalledTimes(1);
  });
});
