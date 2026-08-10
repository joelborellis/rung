// The write queue.
//
// The single constraint this module exists to satisfy: `enqueue` is
// synchronous and never touches the network. `saveReview` calls it and returns;
// Save & next advances immediately whatever the connection is doing (AC-2).
// Everything after that — batching, retrying, backing off — happens on a timer
// the reviewer never waits for.
//
// The queue is a DESIRED-STATE MAP, not a log. Re-saving a scenario replaces
// the pending write for it rather than appending a second one, so a reviewer
// who changes their mind four times still produces one request, and the queue
// is bounded by the number of scenarios rather than the number of keystrokes.
// That is only safe because every operation is idempotent last-writer-wins.
//
// Storage lives at `srs:outbox`, deliberately OUTSIDE the `srs:v3:` namespace.
// purgeOldVersions() deletes every srs:* key that is not the current version,
// so an outbox inside the namespace would be destroyed by a future version
// bump — taking unsent verdicts with it.

import type { ProposedScenario, Resolution, ScenarioReview } from '../types/review';

export const OUTBOX_KEY = 'srs:outbox';
export const OUTBOX_SCHEMA = 1;

export type OpKind =
  | 'review.put'
  | 'review.del'
  | 'proposal.put'
  | 'proposal.del'
  | 'resolution.put'
  | 'resolution.del';

export type OutboxOp = {
  opId: string;
  kind: OpKind;
  /** scenarioId, tempId, or resolution key. */
  key: string;
  payload?: unknown;
  queuedAt: string;
  attempts: number;
  lastError?: string;
};

export type OutboxFile = {
  schemaVersion: number;
  ops: OutboxOp[];
  /** Ops the server refused for a reason retrying will not fix. */
  dead: OutboxOp[];
};

/** Which family an op belongs to, for coalescing. */
function family(kind: OpKind): string {
  return kind.split('.')[0]!;
}

const empty = (): OutboxFile => ({ schemaVersion: OUTBOX_SCHEMA, ops: [], dead: [] });

export function readOutbox(storage: Storage = window.localStorage): OutboxFile {
  try {
    const raw = storage.getItem(OUTBOX_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<OutboxFile>;
    if (parsed?.schemaVersion !== OUTBOX_SCHEMA || !Array.isArray(parsed.ops)) return empty();
    return { schemaVersion: OUTBOX_SCHEMA, ops: parsed.ops, dead: parsed.dead ?? [] };
  } catch {
    // Private mode, quota, or corruption. An unusable outbox must not stop the
    // reviewer working — the file export is still there.
    return empty();
  }
}

export function writeOutbox(file: OutboxFile, storage: Storage = window.localStorage): void {
  try {
    storage.setItem(OUTBOX_KEY, JSON.stringify(file));
  } catch {
    /* nothing useful to do; the session still works */
  }
}

let nextId = 0;
function opId(): string {
  // randomUUID is not available in every context this runs in (older Safari,
  // some test environments), and uniqueness only has to hold within one queue.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  nextId += 1;
  return `op-${nextId}`;
}

/**
 * Add an operation, replacing any pending one for the same thing.
 *
 * Synchronous by contract. Callers are in the Save & next path.
 */
export function enqueue(
  op: Omit<OutboxOp, 'opId' | 'queuedAt' | 'attempts'>,
  storage: Storage = window.localStorage,
): OutboxFile {
  const file = readOutbox(storage);
  const fam = family(op.kind);
  const ops = file.ops.filter((entry) => !(family(entry.kind) === fam && entry.key === op.key));
  ops.push({ ...op, opId: opId(), queuedAt: new Date().toISOString(), attempts: 0 });

  const next = { ...file, ops };
  writeOutbox(next, storage);
  return next;
}

export const enqueueReview = (review: ScenarioReview, storage?: Storage) =>
  enqueue({ kind: 'review.put', key: review.scenarioId, payload: review }, storage);

export const enqueueReviewDelete = (scenarioId: string, storage?: Storage) =>
  enqueue({ kind: 'review.del', key: scenarioId }, storage);

export const enqueueProposal = (proposal: ProposedScenario, storage?: Storage) =>
  enqueue({ kind: 'proposal.put', key: proposal.tempId, payload: proposal }, storage);

export const enqueueProposalDelete = (tempId: string, storage?: Storage) =>
  enqueue({ kind: 'proposal.del', key: tempId }, storage);

export const enqueueResolution = (resolution: Resolution, storage?: Storage) =>
  enqueue({ kind: 'resolution.put', key: resolution.key, payload: resolution }, storage);

export const enqueueResolutionDelete = (key: string, storage?: Storage) =>
  enqueue({ kind: 'resolution.del', key }, storage);

/** Scenario ids with an unsent write — pull must not overwrite these. */
export function pendingScenarioIds(storage: Storage = window.localStorage): Set<string> {
  return new Set(
    readOutbox(storage)
      .ops.filter((op) => op.kind === 'review.put' || op.kind === 'review.del')
      .map((op) => op.key),
  );
}

export function outboxSize(storage: Storage = window.localStorage): number {
  return readOutbox(storage).ops.length;
}

/** Remove ops that succeeded; bump attempts and record the error on the rest. */
export function settle(
  { done, failed, dead }: { done: string[]; failed?: Array<{ opId: string; error: string }>; dead?: string[] },
  storage: Storage = window.localStorage,
): OutboxFile {
  const file = readOutbox(storage);
  const doneSet = new Set(done);
  const deadSet = new Set(dead ?? []);
  const errors = new Map((failed ?? []).map((entry) => [entry.opId, entry.error]));

  const next: OutboxFile = {
    schemaVersion: OUTBOX_SCHEMA,
    ops: file.ops
      .filter((op) => !doneSet.has(op.opId) && !deadSet.has(op.opId))
      .map((op) =>
        errors.has(op.opId)
          ? { ...op, attempts: op.attempts + 1, lastError: errors.get(op.opId) }
          : op,
      ),
    // Keep the dead letters so the UI can tell the reviewer to export instead.
    dead: [...file.dead, ...file.ops.filter((op) => deadSet.has(op.opId))].slice(-100),
  };

  writeOutbox(next, storage);
  return next;
}

export function clearDead(storage: Storage = window.localStorage): OutboxFile {
  const file = readOutbox(storage);
  const next = { ...file, dead: [] };
  writeOutbox(next, storage);
  return next;
}

/** Exponential with jitter, capped. Jitter stops a fleet retrying in lockstep. */
export function backoffMs(attempts: number, random = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempts - 1));
  const jitter = base * 0.2 * (random() * 2 - 1);
  return Math.round(base + jitter);
}
