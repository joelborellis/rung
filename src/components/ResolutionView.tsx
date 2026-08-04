// Spec §5.5 — owner mode. Every change verdict and every reviewer split, side
// by side with the current value, plus id assignment for submitted scenarios.

import { useMemo, useState } from 'react';
import { currentLabel } from '../lib/merge';
import { allOverlays, nextProposalId, useStore, type Store } from '../store/useStore';
import { resolutionKey, type ProposedScenario, type Resolution } from '../types/review';
import { isKnownTier, type FileKind, type Scenario, type Tier } from '../types/scenario';
import { TierLadder } from './TierLadder';
import { EmptyState, Eyebrow, Modal } from './ui';

type Item = {
  scenario: Scenario;
  reviewerId: string;
  reviewerName: string;
  concern: 'label' | 'rationale' | 'realism' | 'text';
  currentValue: string;
  proposedValue: string;
  because: string;
};

export function ResolutionView({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FileKind>(useStore.getState().activeFile);
  const file = useStore((state: Store) => state.set[kind]);
  const overlays = useStore(allOverlays);
  const resolutions = useStore((state) => state.resolutions);
  const resolve = useStore((state) => state.resolve);
  const unresolve = useStore((state) => state.unresolve);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    for (const scenario of file.scenarios) {
      for (const overlay of overlays) {
        const review = overlay.reviews[scenario.id];
        if (!review) continue;
        const who = overlay.reviewer.displayName;
        if (review.labelVerdict.kind === 'change') {
          list.push({
            scenario,
            reviewerId: overlay.reviewer.id,
            reviewerName: who,
            concern: 'label',
            currentValue: currentLabel(scenario),
            proposedValue: String(review.labelVerdict.proposed),
            because: review.labelVerdict.because,
          });
        }
        if (review.rationaleVerdict.kind === 'flawed') {
          list.push({
            scenario,
            reviewerId: overlay.reviewer.id,
            reviewerName: who,
            concern: 'rationale',
            currentValue: scenario.kind === 'input' ? scenario.rationale : scenario.reason,
            proposedValue: '—',
            because: review.rationaleVerdict.because,
          });
        }
        if (review.realismVerdict.kind === 'unrealistic') {
          list.push({
            scenario,
            reviewerId: overlay.reviewer.id,
            reviewerName: who,
            concern: 'realism',
            currentValue: '—',
            proposedValue: '—',
            because: review.realismVerdict.because,
          });
        }
        const edits = review.proposedTextEdits;
        if (edits && Object.keys(edits).length > 0) {
          const field = Object.keys(edits)[0] as keyof typeof edits;
          list.push({
            scenario,
            reviewerId: overlay.reviewer.id,
            reviewerName: who,
            concern: 'text',
            currentValue: String(
              (scenario as unknown as Record<string, unknown>)[field] ?? '',
            ),
            proposedValue: String(edits[field] ?? ''),
            because: `Proposed rewrite of ${field}.`,
          });
        }
      }
    }
    return list;
  }, [file, overlays]);

  const proposals = useMemo(
    () =>
      overlays.flatMap((overlay) =>
        overlay.proposals
          .filter((proposal) => proposal.status === 'submitted' && proposal.targetFile === kind)
          .map((proposal) => ({ proposal, authorName: overlay.reviewer.displayName })),
      ),
    [overlays, kind],
  );

  return (
    <Modal title="Resolve contested items" onClose={onClose} width="max-w-5xl">
      <div className="flex flex-col gap-6">
        <div className="flex gap-2">
          {(['input', 'output'] as FileKind[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              className="btn"
              style={
                kind === option
                  ? { borderColor: 'var(--accent)', color: 'var(--accent)' }
                  : undefined
              }
              onClick={() => setKind(option)}
            >
              {option === 'input' ? 'Input tiers' : 'Output behavior'}
            </button>
          ))}
        </div>

        <section className="flex flex-col gap-3">
          <Eyebrow>Reviewer proposals</Eyebrow>
          {items.length === 0 ? (
            <EmptyState>
              No contested items. Disagreements between reviewers will appear here.
            </EmptyState>
          ) : (
            items.map((item) => {
              const key = resolutionKey(item.scenario.id, item.reviewerId, item.concern);
              const decision = resolutions[key];
              return (
                <ResolutionRow
                  key={key}
                  item={item}
                  decision={decision}
                  onResolve={(next) => resolve({ ...next, key })}
                  onUndo={() => unresolve(key)}
                />
              );
            })
          )}
        </section>

        <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
          <Eyebrow>Submitted scenarios awaiting an id</Eyebrow>
          {proposals.length === 0 ? (
            <EmptyState>No submitted scenarios. Reviewers can add them from the rail.</EmptyState>
          ) : (
            proposals.map(({ proposal, authorName }) => (
              <ProposalRow key={proposal.tempId} proposal={proposal} authorName={authorName} kind={kind} />
            ))
          )}
        </section>
      </div>
    </Modal>
  );
}

function ResolutionRow({
  item,
  decision,
  onResolve,
  onUndo,
}: {
  item: Item;
  decision: Resolution | undefined;
  onResolve: (resolution: Omit<Resolution, 'resolvedAt' | 'key'> & { key?: string }) => void;
  onUndo: () => void;
}) {
  const [manual, setManual] = useState<string>(item.currentValue);
  const [editing, setEditing] = useState(false);
  const isLabel = item.concern === 'label';

  return (
    <article className="rounded-card border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="mono text-sm font-medium">{item.scenario.id}</span>
        <span className="chip text-sm">{item.concern}</span>
        <span className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 62%, transparent)' }}>
          {item.reviewerName}
        </span>
        {decision && (
          <span className="chip" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
            {decision.decision === 'accept'
              ? 'Accepted'
              : decision.decision === 'keep'
                ? 'Kept current'
                : 'Edited manually'}
          </span>
        )}
      </header>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div>
          <Eyebrow>Current</Eyebrow>
          <p
            className="prose mt-1 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            {item.currentValue || '—'}
          </p>
        </div>
        <div>
          <Eyebrow>Proposed</Eyebrow>
          <p
            className="prose mt-1 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--accent)' }}
          >
            {item.proposedValue || '—'}
          </p>
        </div>
      </div>

      <p className="mt-2 text-sm">
        <span className="font-medium">Because: </span>
        {item.because}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn"
          onClick={() =>
            onResolve({
              scenarioId: item.scenario.id,
              reviewerId: item.reviewerId,
              concern: item.concern,
              decision: 'accept',
            })
          }
          disabled={item.concern === 'realism'}
          title={
            item.concern === 'realism'
              ? 'A realism concern has nothing to apply — record it and move on.'
              : undefined
          }
        >
          Accept proposal
        </button>
        <button
          type="button"
          className="btn"
          onClick={() =>
            onResolve({
              scenarioId: item.scenario.id,
              reviewerId: item.reviewerId,
              concern: item.concern,
              decision: 'keep',
            })
          }
        >
          Keep current
        </button>
        {isLabel && (
          <button type="button" className="btn" onClick={() => setEditing((open) => !open)}>
            {editing ? 'Cancel manual edit' : 'Edit manually'}
          </button>
        )}
        {decision && (
          <button type="button" className="btn" onClick={onUndo}>
            Undo
          </button>
        )}
      </div>

      {editing && isLabel && (
        <div className="mt-3 flex flex-col gap-2 rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)' }}>
          {item.scenario.kind === 'input' ? (
            <TierLadder
              compact
              name={`manual-${item.scenario.id}`}
              value={isKnownTier(manual) ? (manual as Tier) : 'no_issue'}
              onChange={(tier) => setManual(tier)}
            />
          ) : (
            <div className="flex gap-2">
              {['true', 'false'].map((value) => (
                <button
                  key={value}
                  type="button"
                  className="btn"
                  aria-pressed={manual === value}
                  style={manual === value ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
                  onClick={() => setManual(value)}
                >
                  {value === 'true' ? 'Pass' : 'Fail'}
                </button>
              ))}
            </div>
          )}
          <button
            type="button"
            className="btn btn-primary self-start"
            onClick={() => {
              onResolve({
                scenarioId: item.scenario.id,
                reviewerId: item.reviewerId,
                concern: item.concern,
                decision: 'manual',
                manualValue: item.scenario.kind === 'output' ? manual === 'true' : manual,
              });
              setEditing(false);
            }}
          >
            Set this value
          </button>
        </div>
      )}
    </article>
  );
}

function ProposalRow({
  proposal,
  authorName,
  kind,
}: {
  proposal: ProposedScenario;
  authorName: string;
  kind: FileKind;
}) {
  const upsertProposal = useStore((state) => state.upsertProposal);
  const suggested = useStore((state: Store) =>
    nextProposalId(state, String(proposal.scenario.category ?? 'scenario'), kind),
  );
  const [id, setId] = useState(proposal.assignedId ?? suggested);

  return (
    <article className="rounded-card border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
      <header className="flex flex-wrap items-center gap-2">
        <span className="mono text-sm font-medium">{proposal.scenario.category}</span>
        <span className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 62%, transparent)' }}>
          from {authorName}
        </span>
        {proposal.accepted && (
          <span className="chip" style={{ borderColor: 'var(--accent)', color: 'var(--accent)' }}>
            Accepted
          </span>
        )}
      </header>
      <p className="mt-1.5 text-base">{proposal.scenario.description}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <label className="text-sm font-medium" htmlFor={`id-${proposal.tempId}`}>
          Assign id
        </label>
        <input
          id={`id-${proposal.tempId}`}
          className="field mono w-[200px]"
          value={id}
          onChange={(event) => setId(event.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => upsertProposal({ ...proposal, assignedId: id.trim(), accepted: true })}
          disabled={id.trim() === ''}
        >
          Accept and assign
        </button>
        {proposal.accepted && (
          <button
            type="button"
            className="btn"
            onClick={() => upsertProposal({ ...proposal, accepted: false })}
          >
            Withdraw acceptance
          </button>
        )}
      </div>
    </article>
  );
}
