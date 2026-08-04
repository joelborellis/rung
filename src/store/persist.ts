// Spec §3 — every mutation persisted immediately, debounced 500ms.
// Key: `srs:v1:{fileHash}:{reviewerId}` for overlays, plus a workspace index
// that holds the roster, the owner's resolutions, and the last position.

import type { Resolution, ReviewOverlay, Reviewer } from '../types/review';

const PREFIX = 'srs:v1';
export const INDEX_KEY = `${PREFIX}:index`;

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

export type WorkspaceIndex = {
  fileHash: string;
  reviewers: Reviewer[];
  activeReviewerId: string | null;
  activeFile: 'input' | 'output';
  activeScenarioId: string | null;
  resolutions: Record<string, Resolution>;
  ownerMode: boolean;
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

/** Debounced by key so a burst of keystrokes writes once. */
export function persistDebounced(key: string, value: unknown, delay = 500): void {
  const existing = timers.get(key);
  if (existing) clearTimeout(existing);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      writeJson(key, value);
    }, delay),
  );
}

/** Called before unload so nothing in flight is lost. */
export function flushPending(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
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
