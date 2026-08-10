// Whether the reviewer's work has reached the server.
//
// Deliberately quiet. Sync working is the normal case and should not draw the
// eye; the states worth noticing are "unsent" and "couldn't sync", and only
// those get colour. No spinner — a spinner on every save would make a working
// system look busy and anxious, and §7 asks for a clinical instrument.

import { useSyncStore, syncLabel, type SyncStatus } from '../sync/useSyncStore';
import { drain } from '../sync/drain';

/** Only two states earn colour; everything else is ordinary text. */
function toneFor(status: SyncStatus, dead: number): string {
  if (dead > 0 || status === 'signed-out') return 'var(--flag)';
  if (status === 'offline') return 'var(--flag)';
  return 'color-mix(in srgb, var(--ink) 55%, transparent)';
}

export function SyncChip() {
  const status = useSyncStore((s) => s.status);
  const pending = useSyncStore((s) => s.pending);
  const dead = useSyncStore((s) => s.dead);
  const lastError = useSyncStore((s) => s.lastError);

  // Local mode still gets a chip. It is static, so it is not noise — and
  // without it there is no way to tell "saved to the server" from "saved only
  // in this browser", which is exactly the confusion worth preventing.
  const label = syncLabel({ status, pending, dead });
  const colour = toneFor(status, dead.length);
  const actionable = status === 'offline' || status === 'signed-out' || dead.length > 0;

  const title =
    dead.length > 0
      ? "Some verdicts couldn't be saved. Export your review file and send it to Joel."
      : status === 'local'
        ? 'Not signed in to the server — your work is only in this browser. Export your review file when you finish.'
        : (lastError ?? (pending > 0 ? `${pending} waiting to send` : 'Everything is saved'));

  return (
    <button
      type="button"
      className="chip"
      style={{ color: colour, borderColor: actionable ? 'var(--flag)' : 'var(--line)' }}
      title={title}
      aria-live="polite"
      onClick={() => {
        // Retry now rather than waiting out the backoff. Harmless when there
        // is nothing to send.
        void drain();
      }}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 rounded-full"
        style={{
          background: actionable ? 'var(--flag)' : 'var(--ok, var(--accent))',
          opacity: status === 'saving' ? 0.5 : 1,
        }}
      />
      {label}
    </button>
  );
}
