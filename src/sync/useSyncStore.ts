// Sync status, in its own store.
//
// Deliberately separate from useStore: a "Saving…" tick changing twice a
// second must not re-render the workspace, and sync state must never be
// reachable from anything that serialises a ReviewOverlay. Keeping it in a
// different store makes both structural rather than a matter of discipline.

import { create } from 'zustand';
import type { Role } from './client';
import type { OutboxOp } from './outbox';

export type SyncStatus =
  | 'idle' // nothing to send, everything acknowledged
  | 'saving' // a drain is in flight
  | 'offline' // the last attempt failed; work is queued
  | 'signed-out' // the server rejected the session
  | 'local'; // no server configured — file-only mode, the old behaviour

export type SyncState = {
  status: SyncStatus;
  /** Unsent operations. Shown as "3 unsent" when non-zero. */
  pending: number;
  /** Rejected for good; the reviewer is told to export instead. */
  dead: OutboxOp[];
  lastSyncedAt: string | null;
  lastError: string | null;
  role: Role | null;
  enrolled: boolean;
  /** Null until the session resolves; drives the reconnect banner. */
  signedIn: boolean;
  /** The open batch. The label is what the owner types to confirm a promote. */
  roundId: string | null;
  roundLabel: string | null;
};

export type SyncActions = {
  set: (patch: Partial<SyncState>) => void;
  reset: () => void;
};

const INITIAL: SyncState = {
  status: 'local',
  pending: 0,
  dead: [],
  lastSyncedAt: null,
  lastError: null,
  role: null,
  enrolled: false,
  signedIn: false,
  roundId: null,
  roundLabel: null,
};

export const useSyncStore = create<SyncState & SyncActions>((set) => ({
  ...INITIAL,
  set: (patch) => set(patch),
  reset: () => set(INITIAL),
}));

/** Header copy. One place, so the wording cannot drift between surfaces. */
export function syncLabel(state: Pick<SyncState, 'status' | 'pending' | 'dead'>): string {
  if (state.dead.length > 0) {
    return `${state.dead.length} couldn't sync`;
  }
  switch (state.status) {
    case 'saving':
      return 'Saving…';
    case 'offline':
      return state.pending > 0 ? `Offline — ${state.pending} unsent` : 'Offline';
    case 'signed-out':
      return 'Reconnect';
    case 'local':
      return 'Saved on this device';
    case 'idle':
    default:
      return state.pending > 0 ? `${state.pending} unsent` : 'Saved';
  }
}
