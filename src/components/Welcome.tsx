// Spec §5.1 — first run. One centred card: what this is, what their review
// does, the content note, name, optional credentials, "Begin review."

import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Labelled } from './ui';

export function Welcome() {
  const signIn = useStore((state) => state.signIn);
  const reviewers = useStore((state) => state.reviewers);
  const switchReviewer = useStore((state) => state.switchReviewer);
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState('');
  const [touched, setTouched] = useState(false);

  const nameOk = name.trim().length >= 2;

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
            You'll see 24 scenarios, one at a time, as a chat between a client and the coach.
            For each one you answer three questions: is the label right, is the reasoning sound,
            and would a real client say this. It takes about an hour. Your answers become the
            answer key the system is tested against, so a scenario you overrule is a scenario
            that changes.
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
