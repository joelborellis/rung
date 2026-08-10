// The drain loop: what actually sends the outbox.
//
// Scheduling, not speed, is the design here. A reviewer working through
// scenarios produces one request every second or two, not one per verdict, and
// nothing they do ever waits on a response. The triggers are:
//
//   * 1.5s after the last enqueue (the common case — batches a burst)
//   * coming back online
//   * the tab becoming visible again
//   * a 30s safety timer, in case an event was missed
//   * pagehide, via sendBeacon, so closing the tab does not strand work
//
// The transport is injected so the whole loop can be tested without a server.

import { api, SyncError, type Api } from './client';
import {
  backoffMs,
  readOutbox,
  settle,
  type OutboxOp,
} from './outbox';
import { useSyncStore } from './useSyncStore';
import type { ProposedScenario, Resolution, ScenarioReview } from '../types/review';

export type DrainDeps = {
  transport: Api;
  storage: Storage;
  now: () => number;
  random: () => number;
};

/**
 * Fill in what the caller did not supply. Written as per-field `??` rather
 * than a spread over a defaults object so `window` is only touched when
 * storage was not injected — otherwise this module cannot be tested, or run,
 * outside a browser.
 */
function resolve(deps: Partial<DrainDeps>): DrainDeps {
  return {
    transport: deps.transport ?? api,
    storage: deps.storage ?? window.localStorage,
    now: deps.now ?? Date.now,
    random: deps.random ?? Math.random,
  };
}

let inFlight: Promise<void> | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let safety: ReturnType<typeof setInterval> | undefined;
/** Epoch ms before which we should not retry, set by backoff. */
let quietUntil = 0;

export const DEBOUNCE_MS = 1500;
export const SAFETY_MS = 30_000;

/** Ask for a drain soon. Cheap, synchronous, safe to call on every keystroke. */
export function scheduleDrain(deps: Partial<DrainDeps> = {}, delay = DEBOUNCE_MS): void {
  clearTimeout(timer);
  timer = setTimeout(() => void drain(deps), delay);
}

/**
 * Send everything queued. Concurrent calls share one run rather than racing —
 * two drains at once would double-send and fight over the settle.
 */
export function drain(deps: Partial<DrainDeps> = {}): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = runDrain(resolve(deps)).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function runDrain(deps: DrainDeps): Promise<void> {
  const sync = useSyncStore.getState();
  if (sync.status === 'local' || !sync.signedIn) return;

  const file = readOutbox(deps.storage);
  if (file.ops.length === 0) {
    sync.set({ status: 'idle', pending: 0 });
    return;
  }
  if (deps.now() < quietUntil) return;

  sync.set({ status: 'saving', pending: file.ops.length });

  const done: string[] = [];
  const failed: Array<{ opId: string; error: string }> = [];
  const dead: string[] = [];
  let sawRetryable = false;
  let signedOut = false;

  const record = (op: OutboxOp, error: unknown) => {
    if (error instanceof SyncError && error.status === 401) {
      signedOut = true;
      failed.push({ opId: op.opId, error: error.message });
      return;
    }
    if (error instanceof SyncError && !error.retryable) {
      // A 400 will fail identically forever. Retrying is a busy-loop that
      // hides the problem; dead-lettering surfaces it.
      dead.push(op.opId);
      return;
    }
    sawRetryable = true;
    failed.push({ opId: op.opId, error: error instanceof Error ? error.message : 'Failed' });
  };

  // Reviews go as one batch: this is the bulk of the traffic and the endpoint
  // reports per-item outcomes, so one bad verdict cannot strand the rest.
  const reviewPuts = file.ops.filter((op) => op.kind === 'review.put');
  const reviewDels = file.ops.filter((op) => op.kind === 'review.del');

  if (reviewPuts.length > 0 || reviewDels.length > 0) {
    try {
      const result = await deps.transport.reviewsBatch(
        reviewPuts.map((op) => op.payload as ScenarioReview),
        reviewDels.map((op) => op.key),
      );
      const rejected = new Map(result.rejected.map((entry) => [entry.scenarioId, entry.message]));
      for (const op of [...reviewPuts, ...reviewDels]) {
        if (rejected.has(op.key)) dead.push(op.opId);
        // `stale` means the server already holds something newer. Nothing to
        // do, and nothing wrong — retire the op.
        else done.push(op.opId);
      }
    } catch (error) {
      for (const op of [...reviewPuts, ...reviewDels]) record(op, error);
    }
  }

  // The rest are low-volume and go one at a time; a shared endpoint would be
  // more machinery than the traffic justifies.
  for (const op of file.ops) {
    if (op.kind === 'review.put' || op.kind === 'review.del') continue;
    if (signedOut) break; // no point continuing once the session is gone
    try {
      switch (op.kind) {
        case 'proposal.put':
          await deps.transport.putProposal(op.payload as ProposedScenario);
          break;
        case 'proposal.del':
          await deps.transport.deleteProposal(op.key);
          break;
        case 'resolution.put':
          await deps.transport.putResolution(op.payload as Resolution);
          break;
        case 'resolution.del':
          await deps.transport.deleteResolution(op.key);
          break;
      }
      done.push(op.opId);
    } catch (error) {
      record(op, error);
    }
  }

  const after = settle({ done, failed, dead }, deps.storage);
  const state = useSyncStore.getState();

  if (signedOut) {
    // Keep the queue. The reviewer signs back in and it flushes.
    state.set({
      status: 'signed-out',
      signedIn: false,
      pending: after.ops.length,
      dead: after.dead,
      lastError: 'Your session ended. Open your review link again.',
    });
    return;
  }

  if (sawRetryable) {
    const worst = Math.max(1, ...after.ops.map((op) => op.attempts));
    const wait = backoffMs(worst, deps.random);
    quietUntil = deps.now() + wait;
    state.set({
      status: 'offline',
      pending: after.ops.length,
      dead: after.dead,
      lastError: after.ops[0]?.lastError ?? 'Could not reach the server.',
    });
    scheduleDrain(deps, wait);
    return;
  }

  quietUntil = 0;
  state.set({
    status: 'idle',
    pending: after.ops.length,
    dead: after.dead,
    lastError: after.dead.length > 0 ? "Some verdicts couldn't be saved to the server." : null,
    lastSyncedAt: new Date(deps.now()).toISOString(),
  });

  // More arrived while we were sending.
  if (after.ops.length > 0) scheduleDrain(deps, DEBOUNCE_MS);
}

/**
 * Last-gasp flush on tab close. sendBeacon is fire-and-forget and survives the
 * page going away, which fetch does not — and it works without an
 * Authorization header only because the session is a same-origin cookie.
 */
export function beaconFlush(storage: Storage = window.localStorage): void {
  if (typeof navigator === 'undefined' || !navigator.sendBeacon) return;
  const { ops } = readOutbox(storage);
  const upserts = ops.filter((op) => op.kind === 'review.put').map((op) => op.payload);
  const deletes = ops.filter((op) => op.kind === 'review.del').map((op) => op.key);
  if (upserts.length === 0 && deletes.length === 0) return;

  // Deliberately not cleared from the outbox: we get no acknowledgement, so
  // the ops stay queued and are re-sent (idempotently) on the next load.
  navigator.sendBeacon(
    '/api/reviews:batch',
    new Blob([JSON.stringify({ upserts, deletes })], { type: 'application/json' }),
  );
}

/** Wire the browser triggers. Returns a teardown for tests and HMR. */
export function startDrainLoop(deps: Partial<DrainDeps> = {}): () => void {
  const onOnline = () => void drain(deps);
  const onVisible = () => {
    if (document.visibilityState === 'visible') void drain(deps);
    else beaconFlush(deps.storage ?? window.localStorage);
  };
  const onPageHide = () => beaconFlush(deps.storage ?? window.localStorage);

  window.addEventListener('online', onOnline);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('pagehide', onPageHide);
  safety = setInterval(() => void drain(deps), SAFETY_MS);

  return () => {
    window.removeEventListener('online', onOnline);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('pagehide', onPageHide);
    clearInterval(safety);
    clearTimeout(timer);
  };
}

/** Test seam: forget scheduling state between cases. */
export function resetDrainState(): void {
  clearTimeout(timer);
  clearInterval(safety);
  inFlight = null;
  quietUntil = 0;
}
