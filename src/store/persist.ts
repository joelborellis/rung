// Spec §3 — every mutation persisted immediately, debounced 500ms.
// Key: `srs:v2:{fileHash}:{reviewerId}` for overlays, plus a workspace index
// that holds the roster, the owner's resolutions, and the last position.

import type { Resolution, ReviewOverlay, Reviewer } from '../types/review';

const PREFIX = 'srs:v3';
export const INDEX_KEY = `${PREFIX}:index`;

/**
 * Keys that live OUTSIDE the version namespace and must survive every purge.
 *
 * This is load-bearing. `srs:outbox` holds verdicts that have not reached the
 * server yet; `srs:session` holds the identity needed to send them. A version
 * bump is a cache invalidation — it must never destroy work in flight. Putting
 * the outbox under `srs:v3:` would mean the next bump silently deletes
 * unsent verdicts, which is the worst failure this app could have.
 */
const NEVER_PURGE = new Set([
  'srs:outbox',
  'srs:session',
  // Not work in flight, but a safety note the reviewer has already read.
  // Without this the pre-roll reappears on every single load, because the
  // purge runs at module import and this key is not under the version prefix.
  'srs:content-note-seen',
]);

/** Remove persisted state from earlier storage versions. Runs once at load.
 *  With a server, this invalidates a cache rather than discarding a record of
 *  work: anything already synced comes back on the next load. Starting a fresh
 *  batch is now a server-side round, not a storage-version bump. */
function purgeOldVersions(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      // Any srs:* key that isn't the current PREFIX is from an old version.
      if (key && key.startsWith('srs:') && !key.startsWith(`${PREFIX}:`) && !NEVER_PURGE.has(key)) {
        stale.push(key);
      }
    }
    stale.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    // Private mode / storage disabled — nothing persisted anyway.
  }
}

purgeOldVersions();

/**
 * Wipe every version's review state. Backs the owner-facing "Reset all review
 * data" control; the version bump above covers the automatic fresh start.
 */
export function clearAllReviewData(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const key = window.localStorage.key(i);
      // The outbox is spared here too. The caller is expected to refuse the
      // wipe while anything is unsent, but if it slips through, losing the
      // cache is recoverable and losing unsent verdicts is not.
      if (key && key.startsWith('srs:') && !NEVER_PURGE.has(key)) keys.push(key);
    }
    keys.forEach((key) => window.localStorage.removeItem(key));
  } catch {
    /* nothing persisted */
  }
}

/** Stable, cheap, and only ever used to namespace storage per dataset. */
export function fileHash(...texts: string[]): string {
  let hash = 5381;
  for (const text of texts) {
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
  }
  return hash.toString(36);
}

export function overlayKey(hash: string, reviewerId: string): string {
  return `${PREFIX}:${hash}:${reviewerId}`;
}

export function sourceKey(hash: string): string {
  return `${PREFIX}:${hash}:source`;
}

export type StoredSource = {
  inputYaml: string;
  outputYaml: string;
  /** False for the embedded dataset, true once the reviewer imported files. */
  imported: boolean;
};

/**
 * What a reviewer has already been shown. Deliberately *not* part of
 * ReviewOverlay: the overlay is the `.review.json` contract (§4.3 A), and
 * "has this person seen the guide" is workspace state, not a verdict.
 */
export type ReviewerGuidance = {
  seenInputIntro: boolean;
  seenOutputIntro: boolean;
  nudgeDismissed: boolean;
};

export type WorkspaceIndex = {
  fileHash: string;
  reviewers: Reviewer[];
  activeReviewerId: string | null;
  activeFile: 'input' | 'output';
  activeScenarioId: string | null;
  resolutions: Record<string, Resolution>;
  ownerMode: boolean;
  /** Keyed by reviewer id. Absent for workspaces written before this pass. */
  guidance?: Record<string, ReviewerGuidance>;
};

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

let storageBroken = false;

function safeSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota. The session still works; it just won't
    // survive a refresh, and the workspace says so.
    storageBroken = true;
  }
}

export function storageFailed(): boolean {
  return storageBroken;
}

export function readJson<T>(key: string): T | null {
  const raw = safeGet(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function writeJson(key: string, value: unknown): void {
  safeSet(key, JSON.stringify(value));
}

export function removeKey(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* nothing useful to do */
  }
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();
/** Latest value per key, held so a flush can actually write it. */
const pending = new Map<string, unknown>();

/** Debounced by key so a burst of keystrokes writes once. */
export function persistDebounced(key: string, value: unknown, delay = 500): void {
  pending.set(key, value);
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      pending.delete(key);
      writeJson(key, value);
    }, delay),
  );
}

/**
 * Write everything still in flight, now. Called on pagehide so the last 500ms
 * of edits survive a tab close (AC-4).
 */
export function flushPending(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  for (const [key, value] of pending) writeJson(key, value);
  pending.clear();
}

/**
 * Drop everything still in flight without writing. The counterpart to
 * flushPending, and the one a deliberate wipe wants: a pending write would
 * otherwise recreate a key we are about to remove.
 */
export function discardPending(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  pending.clear();
}

export function loadOverlay(hash: string, reviewerId: string): ReviewOverlay | null {
  return readJson<ReviewOverlay>(overlayKey(hash, reviewerId));
}

export function loadIndex(): WorkspaceIndex | null {
  return readJson<WorkspaceIndex>(INDEX_KEY);
}

export function loadSource(hash: string): StoredSource | null {
  return readJson<StoredSource>(sourceKey(hash));
}
