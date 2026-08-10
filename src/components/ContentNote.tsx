// The pre-roll an invited counselor sees once, before the workspace.
//
// An invite link identifies the reviewer, so the Welcome card — and with it
// the §7 content note and the judge-the-coach ground rule — would be skipped
// entirely. Those are a safety requirement and the single most important piece
// of instruction in the app; losing them to win an interaction budget we
// already meet would be a bad trade.
//
// This is interaction #2 of AC-1's three: click the link, click Begin.
//
// It also carries the sentence about where the data goes. Before the backend,
// verdicts never left the reviewer's machine. Now they do, and the copy has to
// say so — the old wording would be actively misleading.

import { useState } from 'react';
import { useStore } from '../store/useStore';
import type { Store } from '../store/useStore';

const SEEN_KEY = 'srs:content-note-seen';

export function hasSeenContentNote(reviewerId: string): boolean {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    return raw ? (JSON.parse(raw) as string[]).includes(reviewerId) : false;
  } catch {
    return false;
  }
}

function markSeen(reviewerId: string): void {
  try {
    const raw = window.localStorage.getItem(SEEN_KEY);
    const seen = raw ? (JSON.parse(raw) as string[]) : [];
    if (!seen.includes(reviewerId)) {
      window.localStorage.setItem(SEEN_KEY, JSON.stringify([...seen, reviewerId]));
    }
  } catch {
    // Private mode: they see it again next load. Repeating a safety note is
    // the right way to fail.
  }
}

export function ContentNote({ reviewerId, onBegin }: { reviewerId: string; onBegin: () => void }) {
  const [busy, setBusy] = useState(false);
  const counts = useStore((state: Store) => ({
    input: state.set.input.scenarios.length,
    output: state.set.output.scenarios.length,
  }));
  const total = counts.input + counts.output;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6 py-12">
      <div
        className="rounded-card border p-7"
        style={{ borderColor: 'var(--line)', background: 'var(--card)' }}
      >
        <h1
          className="text-lg font-semibold"
          style={{ fontFamily: "'Schibsted Grotesk', sans-serif" }}
        >
          Before you start
        </h1>

        <div className="mt-5 flex flex-col gap-4 text-base leading-relaxed">
          <p>
            You'll review {total} scenarios, one at a time. Each is a fictional test case — a
            made-up client, their therapist's instructions, and a short chat with the coach.
            Nothing here describes a real person.
          </p>

          <p>
            One ground rule matters more than the rest:{' '}
            <strong className="font-medium">judge the coach, not the treatment plan.</strong> Every
            scenario starts with a "therapist envelope" — the exercise, hierarchy position, and
            boundaries a fictional therapist set. You might have designed that treatment
            differently; that isn't the question. The question is whether the coach behaved
            correctly <em>given</em> that envelope. If an envelope is genuinely implausible, say so
            in question 3.
          </p>

          <p
            className="rounded-lg border px-4 py-3 text-sm"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            <strong className="font-medium">A note on content.</strong> The scenarios include
            panic, trauma responses, and disclosures of suicidal ideation. They are written to be
            realistic and are deliberately non-graphic — no methods and no means. They are
            presented plainly, without warning banners, because you are reading them as a
            clinician.
          </p>

          <p
            className="rounded-lg border px-4 py-3 text-sm"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            <strong className="font-medium">Where your answers go.</strong> Your verdicts and
            reasoning are saved to this project's private database as you work, under your name, so
            they reach the project owner without you having to send anything. Other reviewers'
            answers stay hidden from you until you've answered the same scenario yourself — that
            keeps the comparison between clinicians meaningful.
          </p>
        </div>

        <button
          type="button"
          className="btn btn-primary mt-7"
          autoFocus
          disabled={busy}
          onClick={() => {
            setBusy(true);
            markSeen(reviewerId);
            onBegin();
          }}
        >
          Begin review
        </button>
      </div>
    </main>
  );
}
