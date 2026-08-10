// Pulling other people's work down.
//
// Urgency is genuinely low for a reviewer: the blind rule means new data only
// ever appears for scenarios they have already finished, so nothing they are
// currently looking at can change. The owner is the one surface that wants
// freshness, and only while the dashboard is open.
//
// Everything uses `?since=`, so a steady-state poll is a few hundred bytes.
// No WebSockets — data changes a few times a minute at peak, and a socket
// would be more moving parts than the traffic justifies.

import { api, type Api } from './client';
import { mergeOverlayInto } from '../../shared/overlay';
import { pendingScenarioIds } from './outbox';
import type { Resolution, ReviewOverlay } from '../types/review';

export const REVIEWER_POLL_MS = 60_000;
export const OWNER_POLL_MS = 15_000;

export type PullResult = {
  overlays: ReviewOverlay[];
  resolutions: Record<string, Resolution>;
  serverTime: string;
};

export type ApplyArgs = {
  /** Overlays already in the store, keyed by reviewer id. */
  existing: Record<string, ReviewOverlay>;
  incoming: ReviewOverlay[];
  /** Who the local reviewer is — their overlay merges, others replace. */
  selfId: string | null;
  /** Scenarios with an unsent local write; the server's copy is older. */
  pending: Set<string>;
};

/**
 * Fold a pull into what is already in memory.
 *
 * Two different rules, for a reason:
 *
 *  - Another reviewer's overlay is REPLACED. The server is authoritative for
 *    them; we never write their data, so there is nothing local to protect.
 *  - The local reviewer's own overlay is MERGED with mergeOverlayInto, and any
 *    scenario with a pending outbox op is skipped entirely. Without that, a
 *    poll landing between "save" and "drain" would overwrite a verdict the
 *    reviewer just entered with the server's older copy — the exact bug that
 *    makes people distrust a sync feature.
 */
export function applyPull({ existing, incoming, selfId, pending }: ApplyArgs): Record<string, ReviewOverlay> {
  const next = { ...existing };

  for (const overlay of incoming) {
    const id = overlay.reviewer.id;
    if (id !== selfId) {
      next[id] = overlay;
      continue;
    }

    const mine = existing[id];
    if (!mine) {
      next[id] = overlay;
      continue;
    }

    const safe: ReviewOverlay = {
      ...overlay,
      reviews: Object.fromEntries(
        Object.entries(overlay.reviews).filter(([scenarioId]) => !pending.has(scenarioId)),
      ),
    };
    next[id] = mergeOverlayInto(mine, safe);
  }

  return next;
}

export type PullDeps = { transport: Api; storage: Storage };

export async function pullOnce(
  since: string | null,
  { transport = api, storage = window.localStorage }: Partial<PullDeps> = {},
): Promise<PullResult & { pending: Set<string> }> {
  const result = await transport.overlays(since);
  return { ...result, pending: pendingScenarioIds(storage) };
}

/**
 * Poll while the tab is visible, pause when it is not, and pull immediately on
 * return. Returns a teardown.
 */
export function startPolling(
  intervalMs: number,
  onTick: () => void | Promise<void>,
): () => void {
  let timer: ReturnType<typeof setInterval> | undefined;

  const start = () => {
    if (timer !== undefined) return;
    timer = setInterval(() => void onTick(), intervalMs);
  };
  const stop = () => {
    clearInterval(timer);
    timer = undefined;
  };

  const onVisibility = () => {
    if (document.visibilityState === 'visible') {
      void onTick(); // catch up straight away rather than waiting a full period
      start();
    } else {
      stop();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  if (document.visibilityState === 'visible') start();

  return () => {
    stop();
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
