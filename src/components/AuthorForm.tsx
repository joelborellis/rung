// Spec §5.4 — guided authoring, not a YAML editor. Drafts persist because
// clinicians start scenarios and get interrupted.

import { useMemo, useState } from 'react';
import { activeReviewer, nextProposalId, useStore, type Store } from '../store/useStore';
import type { ProposedScenario } from '../types/review';
import {
  CATEGORY_GLOSS,
  INPUT_CATEGORIES,
  OUTPUT_CATEGORIES,
  isKnownTier,
  type FileKind,
  type Tier,
  type Turn,
} from '../types/scenario';
import { TierLadder } from './TierLadder';
import { Eyebrow, Labelled, Modal } from './ui';

type Props = { tempId: string; onClose: () => void };

function blankTurns(kind: FileKind): Turn[] {
  return kind === 'input'
    ? [{ role: 'user', content: '' }]
    : [
        { role: 'user', content: '' },
        { role: 'assistant', content: '', judge: true },
      ];
}

export function AuthorForm({ tempId, onClose }: Props) {
  const reviewer = useStore(activeReviewer);
  const activeFile = useStore((state) => state.activeFile);
  const upsertProposal = useStore((state) => state.upsertProposal);
  const removeProposal = useStore((state) => state.removeProposal);
  const existing = useStore((state: Store) =>
    state.activeReviewerId
      ? state.overlays[state.activeReviewerId]?.proposals.find((p) => p.tempId === tempId)
      : undefined,
  );
  const suggestId = useStore((state: Store) => state);

  const [targetFile, setTargetFile] = useState<FileKind>(existing?.targetFile ?? activeFile);
  const [category, setCategory] = useState(String(existing?.scenario.category ?? ''));
  const [customCategory, setCustomCategory] = useState(
    existing && !isKnown(existing.targetFile, String(existing.scenario.category))
      ? String(existing.scenario.category)
      : '',
  );
  const [description, setDescription] = useState(existing?.scenario.description ?? '');
  const [assignedExercise, setAssignedExercise] = useState(
    existing?.scenario.context?.assigned_exercise ?? '',
  );
  const [hierarchy, setHierarchy] = useState(existing?.scenario.context?.hierarchy_position ?? '');
  const [scopeNotes, setScopeNotes] = useState(existing?.scenario.context?.scope_notes ?? '');
  const [turns, setTurns] = useState<Turn[]>(
    existing?.scenario.conversation?.length
      ? existing.scenario.conversation
      : blankTurns(existing?.targetFile ?? activeFile),
  );
  const [tier, setTier] = useState<string>(String(existing?.scenario.expected_tier ?? 'no_issue'));
  const [passes, setPasses] = useState<boolean>(existing?.scenario.expected_result === true);
  const [reason, setReason] = useState(
    existing?.scenario.reason ?? existing?.scenario.rationale ?? '',
  );
  const [feedback, setFeedback] = useState(existing?.scenario.feedback ?? '');
  const [showErrors, setShowErrors] = useState(false);

  const categories = targetFile === 'input' ? INPUT_CATEGORIES : OUTPUT_CATEGORIES;
  const effectiveCategory = category === '__other' ? customCategory.trim() : category;
  const isNewCategory = effectiveCategory !== '' && !isKnown(targetFile, effectiveCategory);

  const judgeIndex = turns.findIndex((turn) => turn.judge === true);

  const problems = useMemo(() => {
    const list: string[] = [];
    if (!effectiveCategory) list.push('Pick a category, or name a new one.');
    if (description.trim() === '') list.push('Add a one-line description.');
    if (turns.length === 0 || turns.every((turn) => turn.content.trim() === '')) {
      list.push('Write at least one turn of the conversation.');
    }
    if (targetFile === 'input' && turns.at(-1)?.role !== 'user') {
      list.push('An input scenario has to end on a client message — that is the message being classified.');
    }
    if (targetFile === 'output' && judgeIndex === -1) {
      list.push('Mark which coach turn is the response under review.');
    }
    if (reason.trim() === '') {
      list.push(targetFile === 'input' ? 'Explain why that tier is right.' : 'Explain why it passes or fails.');
    }
    if (targetFile === 'output' && !passes && feedback.trim() === '') {
      list.push('For a fail, describe what the corrected response does.');
    }
    return list;
  }, [effectiveCategory, description, turns, targetFile, judgeIndex, reason, passes, feedback]);

  function build(status: 'draft' | 'submitted'): ProposedScenario | null {
    if (!reviewer) return null;
    const id = tempId || `new-${reviewer.id}-${String(Date.now()).slice(-6)}`;
    const shared = {
      category: effectiveCategory || 'uncategorised',
      description: description.trim(),
      context: {
        assigned_exercise: assignedExercise,
        hierarchy_position: hierarchy,
        scope_notes: scopeNotes,
      },
      conversation: turns.filter((turn) => turn.content.trim() !== ''),
    };
    return {
      tempId: id,
      targetFile,
      authorId: reviewer.id,
      status,
      assignedId:
        existing?.assignedId ??
        (status === 'submitted' ? nextProposalId(suggestId, effectiveCategory, targetFile) : undefined),
      accepted: existing?.accepted ?? false,
      scenario:
        targetFile === 'input'
          ? { ...shared, expected_tier: tier, rationale: reason }
          : { ...shared, expected_result: passes, reason, feedback: passes ? feedback : feedback },
    };
  }

  function save(status: 'draft' | 'submitted') {
    if (status === 'submitted' && problems.length > 0) {
      setShowErrors(true);
      return;
    }
    const proposal = build(status);
    if (proposal) upsertProposal(proposal);
    onClose();
  }

  function updateTurn(index: number, patch: Partial<Turn>) {
    setTurns((prev) => prev.map((turn, i) => (i === index ? { ...turn, ...patch } : turn)));
  }

  function setJudge(index: number) {
    setTurns((prev) =>
      prev.map((turn, i) => {
        if (turn.role !== 'assistant') return turn;
        const { judge: _drop, ...rest } = turn;
        return i === index ? { ...rest, judge: true } : rest;
      }),
    );
  }

  function move(index: number, delta: number) {
    setTurns((prev) => {
      const next = [...prev];
      const target = index + delta;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  return (
    <Modal title={existing ? 'Edit your scenario' : 'Add a scenario'} onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col gap-6">
        <Labelled label="What kind of scenario is this?">
          <div className="flex flex-col gap-2 sm:flex-row">
            <FileChoice
              selected={targetFile === 'input'}
              title="Classify a client message"
              body="You write a message from the client. The answer is which tier the system should assign."
              onClick={() => {
                setTargetFile('input');
                setCategory('');
                setTurns(blankTurns('input'));
              }}
            />
            <FileChoice
              selected={targetFile === 'output'}
              title="Judge a coach response"
              body="You write an exchange ending in a coach reply. The answer is whether that reply passes."
              onClick={() => {
                setTargetFile('output');
                setCategory('');
                setTurns(blankTurns('output'));
              }}
            />
          </div>
        </Labelled>

        <Labelled label="Category" hint="New categories are welcome — that is how the suite grows.">
          <div className="flex flex-col gap-2">
            {categories.map((option) => (
              <label key={option} className="flex cursor-pointer items-start gap-2 text-sm">
                <input
                  type="radio"
                  name="category"
                  checked={category === option}
                  onChange={() => setCategory(option)}
                  style={{ accentColor: 'var(--accent)', marginTop: 4 }}
                />
                <span>
                  <span className="mono font-medium">{option}</span>
                  <span className="block" style={{ color: 'color-mix(in srgb, var(--ink) 62%, transparent)' }}>
                    {CATEGORY_GLOSS[option]}
                  </span>
                </span>
              </label>
            ))}
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="radio"
                name="category"
                checked={category === '__other'}
                onChange={() => setCategory('__other')}
                style={{ accentColor: 'var(--accent)' }}
              />
              <span>Other</span>
            </label>
            {category === '__other' && (
              <input
                className="field mono"
                placeholder="somatic_preoccupation"
                value={customCategory}
                onChange={(event) => setCustomCategory(event.target.value)}
                aria-label="New category name"
              />
            )}
            {isNewCategory && (
              <p className="text-sm" style={{ color: 'var(--flag)' }}>
                New category — it will carry a badge and is preserved on export.
              </p>
            )}
          </div>
        </Labelled>

        <Labelled label="One-line description" htmlFor="author-description">
          <input
            id="author-description"
            className="field"
            value={description}
            placeholder="Client asks to bring a companion to a solo exposure"
            onChange={(event) => setDescription(event.target.value)}
          />
        </Labelled>

        <fieldset className="flex flex-col gap-3 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <legend className="eyebrow px-1">Therapist envelope</legend>
          <Labelled label="Assigned exercise" htmlFor="author-exercise">
            <input
              id="author-exercise"
              className="field"
              value={assignedExercise}
              placeholder="Elevator, 4 floors, 3 reps"
              onChange={(event) => setAssignedExercise(event.target.value)}
            />
          </Labelled>
          <Labelled label="Hierarchy position" htmlFor="author-hierarchy">
            <input
              id="author-hierarchy"
              className="field"
              value={hierarchy}
              placeholder="rung 4 of 8"
              onChange={(event) => setHierarchy(event.target.value)}
            />
          </Labelled>
          <Labelled label="Scope notes" htmlFor="author-scope">
            <input
              id="author-scope"
              className="field"
              value={scopeNotes}
              placeholder="Situational exposures only."
              onChange={(event) => setScopeNotes(event.target.value)}
            />
          </Labelled>
        </fieldset>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <Eyebrow>Conversation</Eyebrow>
            <div className="flex gap-2">
              <button
                type="button"
                className="btn text-sm"
                onClick={() => setTurns((prev) => [...prev, { role: 'user', content: '' }])}
              >
                + Client turn
              </button>
              <button
                type="button"
                className="btn text-sm"
                onClick={() => setTurns((prev) => [...prev, { role: 'assistant', content: '' }])}
              >
                + Coach turn
              </button>
            </div>
          </div>

          {turns.map((turn, index) => (
            <div key={index} className="rounded-lg border px-3 py-2" style={{ borderColor: 'var(--line)' }}>
              <div className="flex flex-wrap items-center gap-2 pb-2">
                <span className="chip">{turn.role === 'user' ? 'Client' : 'Coach'}</span>
                {targetFile === 'output' && turn.role === 'assistant' && (
                  <label className="chip cursor-pointer" title="The verdict is about this turn">
                    <input
                      type="radio"
                      name="judge-turn"
                      checked={turn.judge === true}
                      onChange={() => setJudge(index)}
                      style={{ accentColor: 'var(--accent)' }}
                    />
                    This is the response under review
                  </label>
                )}
                <span className="ml-auto flex gap-1">
                  <button type="button" className="btn text-sm" onClick={() => move(index, -1)} aria-label="Move turn up">
                    ↑
                  </button>
                  <button type="button" className="btn text-sm" onClick={() => move(index, 1)} aria-label="Move turn down">
                    ↓
                  </button>
                  <button
                    type="button"
                    className="btn text-sm"
                    onClick={() => setTurns((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Remove turn"
                  >
                    Remove
                  </button>
                </span>
              </div>
              <textarea
                className="field"
                rows={3}
                value={turn.content}
                placeholder={turn.role === 'user' ? 'What the client writes…' : 'What the coach replies…'}
                onChange={(event) => updateTurn(index, { content: event.target.value })}
                aria-label={`${turn.role === 'user' ? 'Client' : 'Coach'} turn ${index + 1}`}
              />
            </div>
          ))}
        </div>

        <fieldset className="flex flex-col gap-3 rounded-lg border px-4 py-3" style={{ borderColor: 'var(--line)' }}>
          <legend className="eyebrow px-1">The answer</legend>
          {targetFile === 'input' ? (
            <>
              <TierLadder
                name="author-tier"
                value={isKnownTier(tier) ? (tier as Tier) : 'no_issue'}
                onChange={(value) => setTier(value)}
              />
              <Labelled label="Why is that the right tier?" htmlFor="author-rationale">
                <textarea
                  id="author-rationale"
                  className="field"
                  rows={4}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Labelled>
            </>
          ) : (
            <>
              <div className="flex gap-2">
                {[true, false].map((value) => (
                  <button
                    key={String(value)}
                    type="button"
                    aria-pressed={passes === value}
                    className="rounded-md border px-4 py-2 font-medium"
                    style={{
                      borderColor: passes === value ? 'var(--accent)' : 'var(--line)',
                      background: passes === value ? 'var(--accent)' : 'var(--card)',
                      color: passes === value ? '#fff' : 'var(--ink)',
                    }}
                    onClick={() => setPasses(value)}
                  >
                    {value ? 'Pass' : 'Fail'}
                  </button>
                ))}
              </div>
              <Labelled label="Why does it pass or fail?" htmlFor="author-reason">
                <textarea
                  id="author-reason"
                  className="field"
                  rows={4}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                />
              </Labelled>
              {!passes && (
                <Labelled
                  label="What does the corrected response do?"
                  htmlFor="author-feedback"
                  hint="Describe the reply that would have been right."
                >
                  <textarea
                    id="author-feedback"
                    className="field"
                    rows={4}
                    value={feedback}
                    onChange={(event) => setFeedback(event.target.value)}
                  />
                </Labelled>
              )}
            </>
          )}
        </fieldset>

        {showErrors && problems.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm" style={{ borderColor: 'var(--flag)' }}>
            {problems.map((problem) => (
              <li key={problem} style={{ color: 'var(--flag)' }}>
                {problem}
              </li>
            ))}
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-3 border-t pt-4" style={{ borderColor: 'var(--line)' }}>
          <button type="button" className="btn btn-primary" onClick={() => save('submitted')}>
            Submit scenario
          </button>
          <button type="button" className="btn" onClick={() => save('draft')}>
            Save as draft
          </button>
          {existing && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                removeProposal(existing.tempId);
                onClose();
              }}
            >
              Delete draft
            </button>
          )}
          <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
            Submitted scenarios are appended to the file once the project owner assigns an id.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function isKnown(kind: FileKind, value: string): boolean {
  const known: readonly string[] = kind === 'input' ? INPUT_CATEGORIES : OUTPUT_CATEGORIES;
  return known.includes(value);
}

function FileChoice({
  selected,
  title,
  body,
  onClick,
}: {
  selected: boolean;
  title: string;
  body: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className="flex-1 rounded-lg border px-4 py-3 text-left"
      style={{
        borderColor: selected ? 'var(--accent)' : 'var(--line)',
        background: selected ? 'color-mix(in srgb, var(--accent) 6%, var(--card))' : 'var(--card)',
      }}
    >
      <span className="block font-medium">{title}</span>
      <span className="block text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 62%, transparent)' }}>
        {body}
      </span>
    </button>
  );
}
