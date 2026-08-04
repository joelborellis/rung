// Spec §5.2 — the scenario stage: therapist envelope, conversation, and the
// proposed answer the reviewer is agreeing with or overruling.

import { useMemo } from 'react';
import { disagreementSummary, labelsFor } from '../lib/agreement';
import { initials } from '../lib/stamps';
import { allOverlays, contestedForFile, useStore, type Store } from '../store/useStore';
import {
  CATEGORY_GLOSS,
  isKnownCategory,
  isPreFlagged,
  type Context,
  type Scenario,
  type Turn,
} from '../types/scenario';
import { TierLadder } from './TierLadder';
import { Chip, Eyebrow } from './ui';

export function Stage({ scenario }: { scenario: Scenario }) {
  const activeFile = useStore((state) => state.activeFile);
  const overlays = useStore(allOverlays);
  const contested = useStore((state: Store) => contestedForFile(state, state.activeFile));

  const labels = useMemo(() => labelsFor(scenario, overlays), [scenario, overlays]);
  const isContested = contested.has(scenario.id);

  return (
    <article className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="mono text-md font-semibold">{scenario.id}</h2>
            <Chip title={CATEGORY_GLOSS[String(scenario.category)]}>
              <span className="mono text-sm">{String(scenario.category)}</span>
            </Chip>
            {!isKnownCategory(activeFile, String(scenario.category)) && (
              <Chip tone="flag">new category</Chip>
            )}
            {isPreFlagged(scenario.id) && (
              <Chip tone="flag" title="Marked at import as needing extra scrutiny">
                needs extra scrutiny
              </Chip>
            )}
          </div>
          <p className="mt-1.5 text-base">{scenario.description}</p>
        </div>
      </header>

      {/* Shown for a reviewer split *and* for a single unresolved change
          verdict — both are contested per §4.3, and in either case the
          proposal on the table is what the next reader needs to see. */}
      {isContested && labels.length > 0 && (
        <DisagreementStrip summary={disagreementSummary(labels, initials)} labels={labels} />
      )}

      <ContextCard context={scenario.context} />

      <section aria-label="Conversation" className="flex flex-col gap-3">
        <Eyebrow>Conversation</Eyebrow>
        <div className="flex flex-col gap-4">
          {scenario.conversation.map((turn, index) => (
            <Bubble key={index} turn={turn} />
          ))}
        </div>
      </section>

      <ProposedAnswer scenario={scenario} />
    </article>
  );
}

function DisagreementStrip({
  summary,
  labels,
}: {
  summary: string;
  labels: ReturnType<typeof labelsFor>;
}) {
  return (
    <details
      className="rounded-lg border px-4 py-2.5"
      style={{ borderColor: 'var(--flag)', background: 'color-mix(in srgb, var(--flag) 5%, var(--card))' }}
    >
      <summary className="cursor-pointer text-sm">
        <span className="font-medium">Contested — </span>
        {summary}
      </summary>
      <ul className="mt-2 flex flex-col gap-1.5 border-t pt-2 text-sm" style={{ borderColor: 'var(--line)' }}>
        {labels.map((entry) => (
          <li key={entry.reviewerId}>
            <span className="font-medium">{entry.displayName}</span>{' '}
            <span className="mono">{entry.label}</span>
            {entry.because && (
              <span style={{ color: 'color-mix(in srgb, var(--ink) 70%, transparent)' }}> — {entry.because}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * The therapist envelope. Visually distinct from the conversation because the
 * reviewer has to judge the scenario *against* it, not read it as dialogue.
 */
function ContextCard({ context }: { context: Context }) {
  return (
    <section
      className="rounded-card border px-5 py-3"
      style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
      aria-label="Therapist envelope"
    >
      <Eyebrow>Therapist envelope</Eyebrow>
      <dl className="mt-2 grid gap-x-6 gap-y-1.5 sm:grid-cols-[auto_1fr]">
        <dt className="text-sm font-medium">Assigned exercise</dt>
        <dd className="prose text-base">{context.assigned_exercise || '—'}</dd>

        <dt className="text-sm font-medium">Hierarchy</dt>
        <dd className="text-base">
          <HierarchyLadder position={context.hierarchy_position} />
        </dd>

        <dt className="text-sm font-medium">Scope notes</dt>
        <dd className="prose text-base">{context.scope_notes || '—'}</dd>
      </dl>
    </section>
  );
}

/**
 * The ladder motif applied to the hierarchy position (§5.2). Parses the common
 * "rung 4 of 8" shape; anything it can't read renders as plain text.
 */
function HierarchyLadder({ position }: { position: string }) {
  const match = /rung\s+(\d+)\s+of\s+(\d+)/i.exec(position);
  if (!match) return <span className="prose">{position || '—'}</span>;
  const current = Number(match[1]);
  const total = Number(match[2]);
  return (
    <span className="flex items-center gap-3">
      <span className="flex items-end gap-[3px]" aria-hidden="true">
        {Array.from({ length: total }, (_, index) => {
          const rung = index + 1;
          const reached = rung <= current;
          return (
            <span
              key={rung}
              className="w-[6px] rounded-sm"
              style={{
                height: `${8 + rung * 1.6}px`,
                background: reached ? 'var(--accent)' : 'var(--line)',
                opacity: rung === current ? 1 : reached ? 0.55 : 1,
              }}
            />
          );
        })}
      </span>
      <span>{position}</span>
    </span>
  );
}

function Bubble({ turn }: { turn: Turn }) {
  const isClient = turn.role === 'user';
  const judged = turn.judge === true;

  return (
    <div className={`flex flex-col gap-1 ${isClient ? 'items-end' : 'items-start'}`}>
      {judged && (
        <Eyebrow className="px-1" >Response under review</Eyebrow>
      )}
      <div className={`flex max-w-[85%] flex-col gap-1 ${isClient ? 'items-end' : 'items-start'}`}>
        <span className="eyebrow px-1">{isClient ? 'Client' : 'Coach'}</span>
        <div
          className="rounded-card border px-4 py-3"
          style={{
            borderColor: judged ? 'var(--accent)' : 'var(--line)',
            borderWidth: judged ? 2 : 1,
            background: isClient ? 'var(--surface)' : 'var(--card)',
          }}
        >
          {/* Exact wording matters — no trimming, no smart quotes (§7). */}
          <p className="prose text-base">{turn.content}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * "Proposed answer — your call." This panel must read as a claim under review,
 * not as a fact the reviewer is being informed of.
 */
function ProposedAnswer({ scenario }: { scenario: Scenario }) {
  return (
    <section
      className="rounded-card border px-5 py-4"
      style={{ borderColor: 'var(--accent)', background: 'var(--card)' }}
      aria-label="Proposed answer"
    >
      <Eyebrow>Proposed answer — your call</Eyebrow>

      {scenario.kind === 'input' ? (
        <div className="mt-3 grid gap-5 lg:grid-cols-[minmax(0,260px)_1fr]">
          <div>
            <p className="mb-2 text-sm font-medium">Proposed tier</p>
            {/* Compact here: the reader needs to see which rung is claimed, and
                all four must fit. The glosses live in the picker (§5.3). */}
            <TierLadder value={scenario.expected_tier} compact />
          </div>
          <div>
            <p className="mb-2 text-sm font-medium">Rationale</p>
            <p className="prose text-base">{scenario.rationale || '—'}</p>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-4">
          <div className="flex items-start gap-4">
            <PassFailChip pass={scenario.expected_result} />
            <div className="min-w-0 flex-1">
              <p className="mb-1 text-sm font-medium">Reason</p>
              <p className="prose text-base">{scenario.reason || '—'}</p>
            </div>
          </div>
          {!scenario.expected_result && scenario.feedback.trim() !== '' && (
            <div className="border-t pt-3" style={{ borderColor: 'var(--line)' }}>
              <Eyebrow>What the corrected response does</Eyebrow>
              <p className="prose mt-1.5 text-base">{scenario.feedback}</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function PassFailChip({ pass, large = true }: { pass: boolean; large?: boolean }) {
  // Border and text only — AC-10: no tier colour is ever a filled surface.
  const color = pass ? 'var(--tier-0)' : 'var(--tier-3)';
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded-lg border-2 font-semibold ${
        large ? 'px-4 py-2 text-md' : 'px-2.5 py-0.5 text-sm'
      }`}
      style={{ borderColor: color, color, background: 'var(--card)' }}
    >
      {pass ? 'PASS' : 'FAIL'}
    </span>
  );
}
