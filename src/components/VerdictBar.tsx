// Spec §5.3 — the verdict bar.
//
// The agree-everything path is exactly four keystrokes: a, a, a, Cmd/Ctrl+Enter
// (each `a` answers the focused group and moves to the next), or four clicks:
// Agree, Sound, Realistic, Save & next. Throughput on the easy cases is what
// buys attention for the hard ones.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { todayIso } from '../lib/stamps';
import { activeReviewer, useStore } from '../store/useStore';
import {
  becauseIsValid,
  type LabelValue,
  type RationaleVerdict,
  type RealismVerdict,
  type ScenarioReview,
  type Verdict,
} from '../types/review';
import { isKnownTier, type Scenario, type Tier } from '../types/scenario';
import { TierLadder } from './TierLadder';
import { BecauseField, Eyebrow } from './ui';

type Draft = {
  label: 'unset' | 'agree' | 'change';
  proposed: LabelValue | null;
  labelBecause: string;
  rationale: 'unset' | 'sound' | 'flawed';
  rationaleBecause: string;
  realism: 'unset' | 'realistic' | 'unrealistic';
  realismBecause: string;
  hardCase: boolean;
  comment: string;
  textEdit: string | null;
};

function emptyDraft(): Draft {
  return {
    label: 'unset',
    proposed: null,
    labelBecause: '',
    rationale: 'unset',
    rationaleBecause: '',
    realism: 'unset',
    realismBecause: '',
    hardCase: false,
    comment: '',
    textEdit: null,
  };
}

function draftFrom(review: ScenarioReview | undefined): Draft {
  if (!review) return emptyDraft();
  return {
    label: review.labelVerdict.kind === 'agree' ? 'agree' : 'change',
    proposed: review.labelVerdict.kind === 'change' ? review.labelVerdict.proposed : null,
    labelBecause: review.labelVerdict.kind === 'change' ? review.labelVerdict.because : '',
    rationale: review.rationaleVerdict.kind === 'sound' ? 'sound' : 'flawed',
    rationaleBecause:
      review.rationaleVerdict.kind === 'flawed' ? review.rationaleVerdict.because : '',
    realism: review.realismVerdict.kind === 'realistic' ? 'realistic' : 'unrealistic',
    realismBecause:
      review.realismVerdict.kind === 'unrealistic' ? review.realismVerdict.because : '',
    hardCase: review.hardCase,
    comment: review.comment ?? '',
    textEdit:
      review.proposedTextEdits?.rationale ?? review.proposedTextEdits?.feedback ?? null,
  };
}

/** The editable prose field for this file kind: rationale in, feedback out. */
function editableField(scenario: Scenario): 'rationale' | 'feedback' {
  return scenario.kind === 'input' ? 'rationale' : 'feedback';
}

function currentText(scenario: Scenario): string {
  return scenario.kind === 'input' ? scenario.rationale : scenario.feedback;
}

export function VerdictBar({ scenario }: { scenario: Scenario }) {
  const reviewer = useStore(activeReviewer);
  const saveReview = useStore((state) => state.saveReview);
  const clearReview = useStore((state) => state.clearReview);
  const advance = useStore((state) => state.advance);
  const existing = useStore((state) =>
    state.activeReviewerId ? state.overlays[state.activeReviewerId]?.reviews[scenario.id] : undefined,
  );

  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing));
  const [focusGroup, setFocusGroup] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [editingText, setEditingText] = useState(false);
  const containerRef = useRef<HTMLElement>(null);

  // A new scenario resets the bar to whatever that scenario already holds.
  useEffect(() => {
    setDraft(draftFrom(existing));
    setFocusGroup(0);
    setShowErrors(false);
    setEditingText(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenario.id]);

  const patch = useCallback((next: Partial<Draft>) => setDraft((prev) => ({ ...prev, ...next })), []);

  const labelBecauseOk = draft.label !== 'change' || becauseIsValid(draft.labelBecause);
  const labelProposedOk = draft.label !== 'change' || draft.proposed !== null;
  const rationaleBecauseOk = draft.rationale !== 'flawed' || becauseIsValid(draft.rationaleBecause);
  const realismBecauseOk = draft.realism !== 'unrealistic' || becauseIsValid(draft.realismBecause);

  const allAnswered =
    draft.label !== 'unset' && draft.rationale !== 'unset' && draft.realism !== 'unset';
  const canSave =
    allAnswered && labelBecauseOk && labelProposedOk && rationaleBecauseOk && realismBecauseOk;

  // §5.3 disables Save until all three verdicts are *set*. A missing "because"
  // leaves the button live on purpose (AC-3): pressing it has to explain why
  // the reason is required, and a dead button explains nothing.
  const saveEnabled = allAnswered;

  const blockedReason = useMemo(() => {
    if (!allAnswered) return 'Answer all three questions to save.';
    if (canSave) return null;
    if (!labelProposedOk) return 'Pick the tier you would assign instead.';
    if (!labelBecauseOk) return 'The label change needs a reason before it can be saved.';
    if (!rationaleBecauseOk) return 'Say what is wrong with the reasoning before saving.';
    if (!realismBecauseOk) return "Say what wouldn't happen, and what would, before saving.";
    return null;
  }, [allAnswered, canSave, labelProposedOk, labelBecauseOk, rationaleBecauseOk, realismBecauseOk]);

  const save = useCallback(() => {
    if (!reviewer) return;
    if (!canSave) {
      setShowErrors(true);
      return;
    }
    const labelVerdict: Verdict<LabelValue> =
      draft.label === 'agree'
        ? { kind: 'agree' }
        : { kind: 'change', proposed: draft.proposed as LabelValue, because: draft.labelBecause.trim() };
    const rationaleVerdict: RationaleVerdict =
      draft.rationale === 'sound'
        ? { kind: 'sound' }
        : { kind: 'flawed', because: draft.rationaleBecause.trim() };
    const realismVerdict: RealismVerdict =
      draft.realism === 'realistic'
        ? { kind: 'realistic' }
        : { kind: 'unrealistic', because: draft.realismBecause.trim() };

    const review: ScenarioReview = {
      scenarioId: scenario.id,
      reviewerId: reviewer.id,
      reviewedAt: todayIso(),
      labelVerdict,
      rationaleVerdict,
      realismVerdict,
      hardCase: draft.hardCase,
    };
    if (draft.comment.trim()) review.comment = draft.comment.trim();
    if (draft.textEdit !== null && draft.textEdit !== currentText(scenario)) {
      review.proposedTextEdits = { [editableField(scenario)]: draft.textEdit };
    }
    saveReview(review);
    advance();
  }, [reviewer, canSave, draft, scenario, saveReview, advance]);

  /** `a` answers the focused group with the agree-side option and advances. */
  const agreeFocused = useCallback(() => {
    setFocusGroup((group) => {
      if (group === 0) patch({ label: 'agree', proposed: null, labelBecause: '' });
      if (group === 1) patch({ rationale: 'sound', rationaleBecause: '' });
      if (group === 2) patch({ realism: 'realistic', realismBecause: '' });
      return Math.min(2, group + 1);
    });
  }, [patch]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable === true;

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        save();
        return;
      }
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === '1' || event.key === '2' || event.key === '3') {
        event.preventDefault();
        setFocusGroup(Number(event.key) - 1);
        return;
      }
      if (event.key === 'a' || event.key === 'A') {
        event.preventDefault();
        agreeFocused();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [save, agreeFocused]);

  const isInput = scenario.kind === 'input';

  return (
    <section
      ref={containerRef}
      aria-label="Your verdict"
      className="sticky bottom-0 z-20 border-t"
      style={{ borderColor: 'var(--line)', background: 'var(--card)' }}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-3 px-6 py-4">
        <div className="grid gap-3 md:grid-cols-3">
          <Group
            index={0}
            focused={focusGroup === 0}
            onFocus={() => setFocusGroup(0)}
            question={isInput ? 'Is this the right tier?' : 'Is this the right call?'}
          >
            <Choice
              selected={draft.label === 'agree'}
              onClick={() => {
                patch({ label: 'agree', proposed: null, labelBecause: '' });
                setFocusGroup(1);
              }}
            >
              Agree
            </Choice>
            <Choice
              selected={draft.label === 'change'}
              onClick={() =>
                patch({
                  label: 'change',
                  proposed:
                    draft.proposed ??
                    (isInput ? null : !(scenario.kind === 'output' && scenario.expected_result)),
                })
              }
            >
              Change…
            </Choice>
          </Group>

          <Group
            index={1}
            focused={focusGroup === 1}
            onFocus={() => setFocusGroup(1)}
            question="Is the reasoning sound?"
          >
            <Choice
              selected={draft.rationale === 'sound'}
              onClick={() => {
                patch({ rationale: 'sound', rationaleBecause: '' });
                setFocusGroup(2);
              }}
            >
              Sound
            </Choice>
            <Choice
              selected={draft.rationale === 'flawed'}
              onClick={() => patch({ rationale: 'flawed' })}
            >
              Flawed…
            </Choice>
          </Group>

          <Group
            index={2}
            focused={focusGroup === 2}
            onFocus={() => setFocusGroup(2)}
            question="Is this realistic?"
          >
            <Choice
              selected={draft.realism === 'realistic'}
              onClick={() => {
                patch({ realism: 'realistic', realismBecause: '' });
                setFocusGroup(2);
              }}
            >
              Realistic
            </Choice>
            <Choice
              selected={draft.realism === 'unrealistic'}
              onClick={() => patch({ realism: 'unrealistic' })}
            >
              Wouldn't happen…
            </Choice>
          </Group>
        </div>

        {draft.label === 'change' && (
          <div className="flex flex-col gap-2 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
            <Eyebrow>What would you assign instead?</Eyebrow>
            {isInput ? (
              <TierLadder
                name={`change-${scenario.id}`}
                value={isKnownTier(String(draft.proposed)) ? (draft.proposed as Tier) : ''}
                onChange={(tier) => patch({ proposed: tier })}
              />
            ) : (
              <div className="flex gap-2">
                {[true, false].map((value) => (
                  <Choice
                    key={String(value)}
                    selected={draft.proposed === value}
                    onClick={() => patch({ proposed: value })}
                  >
                    {value ? 'Pass' : 'Fail'}
                  </Choice>
                ))}
              </div>
            )}
            {showErrors && !labelProposedOk && (
              <p className="text-sm" style={{ color: 'var(--flag)' }}>
                Pick a rung before saving — a change without a target isn't actionable.
              </p>
            )}
            <BecauseField
              id={`label-because-${scenario.id}`}
              value={draft.labelBecause}
              onChange={(value) => patch({ labelBecause: value })}
              invalid={showErrors && !labelBecauseOk}
              placeholder="Because…"
            />
          </div>
        )}

        {draft.rationale === 'flawed' && (
          <div className="flex flex-col gap-2 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
            <div className="flex items-center justify-between gap-3">
              <Eyebrow>What's wrong with the reasoning?</Eyebrow>
              <button
                type="button"
                className="btn text-sm"
                onClick={() => {
                  setEditingText((open) => !open);
                  if (draft.textEdit === null) patch({ textEdit: currentText(scenario) });
                }}
              >
                {editingText ? 'Hide suggested edit' : 'Suggest edit'}
              </button>
            </div>
            <BecauseField
              id={`rationale-because-${scenario.id}`}
              value={draft.rationaleBecause}
              onChange={(value) => patch({ rationaleBecause: value })}
              invalid={showErrors && !rationaleBecauseOk}
              placeholder="Because…"
            />
            {editingText && (
              <TextEditor
                original={currentText(scenario)}
                value={draft.textEdit ?? currentText(scenario)}
                fieldName={editableField(scenario)}
                onChange={(value) => patch({ textEdit: value })}
                onReset={() => patch({ textEdit: null })}
              />
            )}
          </div>
        )}

        {draft.realism === 'unrealistic' && (
          <div className="flex flex-col gap-2 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
            <Eyebrow>What wouldn't happen — the wording, or the setup?</Eyebrow>
            <BecauseField
              id={`realism-because-${scenario.id}`}
              value={draft.realismBecause}
              onChange={(value) => patch({ realismBecause: value })}
              invalid={showErrors && !realismBecauseOk}
              placeholder="Because…"
            />
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <label className="chip cursor-pointer" title="Genuinely ambiguous — reasonable clinicians could disagree">
            <input
              type="checkbox"
              checked={draft.hardCase}
              onChange={(event) => patch({ hardCase: event.target.checked })}
              style={{ accentColor: 'var(--flag)' }}
            />
            Hard case
          </label>

          <input
            className="field min-w-[200px] flex-1"
            placeholder="Comment (optional)"
            value={draft.comment}
            onChange={(event) => patch({ comment: event.target.value })}
            aria-label="Optional comment"
          />

          {existing && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                clearReview(scenario.id);
                setDraft(emptyDraft());
                setFocusGroup(0);
              }}
            >
              Clear my verdict
            </button>
          )}

          <button type="button" className="btn btn-primary" onClick={save} disabled={!saveEnabled}>
            Save &amp; next
          </button>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <p style={{ color: showErrors && blockedReason ? 'var(--flag)' : 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
            {showErrors && blockedReason
              ? blockedReason
              : '1/2/3 moves between questions · a answers the focused one · Ctrl+Enter saves'}
          </p>
          {existing && (
            <p style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
              Saved {new Date(existing.reviewedAt).toLocaleString()}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Group({
  index,
  focused,
  onFocus,
  question,
  children,
}: {
  index: number;
  focused: boolean;
  onFocus: () => void;
  question: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset
      className="rounded-lg border px-3 py-2"
      style={{
        borderColor: focused ? 'var(--accent)' : 'var(--line)',
        background: focused ? 'color-mix(in srgb, var(--accent) 4%, var(--card))' : 'var(--card)',
      }}
      onMouseDown={onFocus}
    >
      <legend className="eyebrow px-1">
        {index + 1}. {question}
      </legend>
      <div className="flex flex-wrap gap-2 pt-1">{children}</div>
    </fieldset>
  );
}

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="rounded-md border px-3 py-1.5 text-sm font-medium"
      style={{
        borderColor: selected ? 'var(--accent)' : 'var(--line)',
        background: selected ? 'var(--accent)' : 'var(--card)',
        color: selected ? '#fff' : 'var(--ink)',
      }}
    >
      {children}
    </button>
  );
}

/** The inline diff view behind "Suggest edit" (§5.3). */
function TextEditor({
  original,
  value,
  fieldName,
  onChange,
  onReset,
}: {
  original: string;
  value: string;
  fieldName: string;
  onChange: (value: string) => void;
  onReset: () => void;
}) {
  const changed = value !== original;
  return (
    <div className="flex flex-col gap-2">
      <div className="grid gap-3 md:grid-cols-2">
        <div>
          <Eyebrow>Current {fieldName}</Eyebrow>
          <p
            className="prose mt-1 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
          >
            {original}
          </p>
        </div>
        <div>
          <Eyebrow>Your {fieldName}</Eyebrow>
          <textarea
            className="field mt-1 text-sm"
            rows={Math.max(4, Math.ceil(value.length / 60))}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            aria-label={`Proposed ${fieldName}`}
          />
        </div>
      </div>
      <div className="flex items-center gap-3 text-sm">
        <button type="button" className="btn text-sm" onClick={onReset} disabled={!changed}>
          Revert to current
        </button>
        <span style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
          {changed
            ? 'Your version is saved as a proposal. The owner accepts it before it reaches the file.'
            : 'No changes yet.'}
        </span>
      </div>
    </div>
  );
}
