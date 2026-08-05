// Spec §5.1 — first run. One centred card: what this is, what their review
// does, the content note, name, optional credentials, "Begin review."

import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Labelled } from './ui';

/** Enough to spell out any plausible sitting; past that, the digit reads fine. */
const HOUR_WORDS: Record<number, string> = { 2: 'two', 3: 'three', 4: 'four', 5: 'five' };

export function Welcome() {
  const signIn = useStore((state) => state.signIn);
  const reviewers = useStore((state) => state.reviewers);
  const switchReviewer = useStore((state) => state.switchReviewer);
  const inputCount = useStore((state) => state.set.input.scenarios.length);
  const outputCount = useStore((state) => state.set.output.scenarios.length);
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState('');
  const [touched, setTouched] = useState(false);

  const nameOk = name.trim().length >= 2;

  // Counted off the loaded set, not typed in: the suite grows with each round
  // of counselor review, and an imported file replaces it outright.
  const total = inputCount + outputCount;
  const hours = Math.max(1, Math.round((total * 2.5) / 60));
  const estimate = hours === 1 ? 'about an hour' : `about ${HOUR_WORDS[hours] ?? hours} hours`;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-12">
      <div className="card w-full px-8 py-8">
        <p className="eyebrow">Handrail safety eval suite</p>
        <h1 className="mt-2 text-xl">Scenario Review Studio</h1>

        <div className="mt-5 flex flex-col gap-4 text-base">
          <p>
            This is a review tool for the safety scenarios behind an exposure-therapy homework
            coach — a tool that supports clients doing the between-session exercises their
            therapist assigned. Before it goes anywhere near a client, the scenarios that define
            safe and unsafe behaviour need a licensed clinician's judgement.
          </p>
          <p>
            You'll review {total} scenarios, one at a time. Each is a fictional test case — a
            made-up client, their therapist's instructions, and a short chat with the coach. Nothing
            here describes a real person. There are two kinds:{' '}
            <strong className="font-medium">input scenarios</strong> ({inputCount}) show a client's
            message and ask whether the proposed <em>handling tier</em> is right, and{' '}
            <strong className="font-medium">output scenarios</strong> ({outputCount}) show a
            response the coach gave and ask whether it should pass or fail.
          </p>
          <p>
            One ground rule matters more than the rest:{' '}
            <strong className="font-medium">judge the coach, not the treatment plan.</strong> Every
            scenario starts with a "therapist envelope" — the exercise, hierarchy position, and
            boundaries a fictional therapist set. You might have designed that treatment
            differently; that isn't the question. The question is whether the coach behaved
            correctly <em>given</em> that envelope. (If an envelope is genuinely implausible — no
            competent therapist would set it — say so in question 3.)
          </p>
          <p>
            For each scenario you answer three questions: is the proposed answer right, is the
            written reasoning sound, and is the scenario realistic. Where you disagree, you'll say
            what you'd assign instead and why. Your verdicts become the answer key this system is
            tested against — a scenario you overrule is a scenario that changes. Expect {estimate}.
            A reference guide stays available in the header the whole time.
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
        </div>

        <form
          className="mt-7 flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (nameOk) signIn(name, credentials);
          }}
        >
          <Labelled label="Your name" htmlFor="reviewer-name">
            <input
              id="reviewer-name"
              className="field"
              value={name}
              autoFocus
              autoComplete="name"
              placeholder="Jane Doe"
              onChange={(event) => setName(event.target.value)}
              aria-invalid={touched && !nameOk}
              style={touched && !nameOk ? { borderColor: 'var(--flag)' } : undefined}
            />
            {touched && !nameOk && (
              <p className="text-sm" style={{ color: 'var(--flag)' }}>
                Enter your name so your verdicts can be told apart from other reviewers'.
              </p>
            )}
          </Labelled>

          <Labelled
            label="Credentials"
            hint="Optional. Appears alongside your verdicts in the exported files."
            htmlFor="reviewer-credentials"
          >
            <input
              id="reviewer-credentials"
              className="field"
              value={credentials}
              placeholder="LPC"
              onChange={(event) => setCredentials(event.target.value)}
            />
          </Labelled>

          <div className="flex items-center gap-3">
            <button type="submit" className="btn btn-primary">
              Begin review
            </button>
            <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
              Your work is saved in this browser as you go.
            </p>
          </div>
        </form>

        {reviewers.length > 0 && (
          <div className="mt-7 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
            <p className="eyebrow">Continue as</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {reviewers.map((reviewer) => (
                <button
                  key={reviewer.id}
                  type="button"
                  className="btn"
                  onClick={() => switchReviewer(reviewer.id)}
                >
                  {reviewer.displayName}
                  {reviewer.credentials ? ` (${reviewer.credentials})` : ''}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
