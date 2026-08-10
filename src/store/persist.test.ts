// AC-14: a verdict saved moments before the tab closes must survive.
//
// Writes are debounced 500ms, so before this fix the last edits of a session
// were silently lost — flushPending() cancelled the pending timers without
// writing their values. The two functions now differ deliberately: flush
// writes, discard drops, and the reset button is the one caller that wants
// drop.

import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeStorage() {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

type Persist = typeof import('./persist');

async function load(): Promise<{ persist: Persist; storage: ReturnType<typeof makeStorage> }> {
  vi.resetModules();
  const storage = makeStorage();
  // persist.ts runs purgeOldVersions() at module load, so the stub has to be
  // in place before the import.
  vi.stubGlobal('window', { localStorage: storage });
  return { persist: await import('./persist'), storage };
}

beforeEach(() => {
  vi.useFakeTimers();
});

describe('persistDebounced', () => {
  it('writes once after the delay, not on every call', async () => {
    const { persist, storage } = await load();
    persist.persistDebounced('srs:v2:k', { n: 1 });
    persist.persistDebounced('srs:v2:k', { n: 2 });
    persist.persistDebounced('srs:v2:k', { n: 3 });
    expect(storage.getItem('srs:v2:k')).toBeNull();

    vi.advanceTimersByTime(500);
    expect(JSON.parse(storage.getItem('srs:v2:k')!)).toEqual({ n: 3 });
  });
});

describe('flushPending', () => {
  it('writes work that is still in flight (AC-14)', async () => {
    const { persist, storage } = await load();
    persist.persistDebounced('srs:v2:overlay', { verdict: 'agree' });
    // The tab dies 100ms later — well inside the debounce window.
    vi.advanceTimersByTime(100);
    persist.flushPending();

    expect(JSON.parse(storage.getItem('srs:v2:overlay')!)).toEqual({ verdict: 'agree' });
  });

  it('writes the latest value per key across several pending keys', async () => {
    const { persist, storage } = await load();
    persist.persistDebounced('srs:v2:a', { v: 1 });
    persist.persistDebounced('srs:v2:b', { v: 2 });
    persist.persistDebounced('srs:v2:a', { v: 3 });
    persist.flushPending();

    expect(JSON.parse(storage.getItem('srs:v2:a')!)).toEqual({ v: 3 });
    expect(JSON.parse(storage.getItem('srs:v2:b')!)).toEqual({ v: 2 });
  });

  it('does not write again when the timer would later fire', async () => {
    const { persist, storage } = await load();
    persist.persistDebounced('srs:v2:k', { v: 1 });
    persist.flushPending();
    storage.removeItem('srs:v2:k');

    vi.advanceTimersByTime(1000);
    expect(storage.getItem('srs:v2:k')).toBeNull();
  });
});

describe('discardPending', () => {
  it('drops work in flight without writing it', async () => {
    // What the reset button needs: a pending write must not recreate a key we
    // are about to remove.
    const { persist, storage } = await load();
    persist.persistDebounced('srs:v2:doomed', { v: 1 });
    persist.discardPending();

    vi.advanceTimersByTime(1000);
    expect(storage.getItem('srs:v2:doomed')).toBeNull();
  });

  it('leaves a wipe clean — nothing reappears afterwards', async () => {
    const { persist, storage } = await load();
    persist.writeJson('srs:v2:index', { reviewers: ['a'] });
    persist.persistDebounced('srs:v2:index', { reviewers: ['a', 'b'] });
    persist.discardPending();
    persist.clearAllReviewData();

    vi.advanceTimersByTime(1000);
    expect(storage.length).toBe(0);
  });
});
