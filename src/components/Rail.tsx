// Spec §5.2 — the scenario rail. Grouped by category, status dot per item,
// pre-flagged markers, hard-case glyphs, and full keyboard navigation.

import { useEffect, useMemo, useRef } from 'react';
import {
  activeOverlay,
  allOverlays,
  contestedForFile,
  useStore,
  type Store,
} from '../store/useStore';
import { CATEGORY_GLOSS, isKnownCategory, isPreFlagged, type Scenario } from '../types/scenario';
import { FlagGlyph, StatusDot, type DotState } from './ui';

function dotState(reviewed: boolean, changed: boolean): DotState {
  if (!reviewed) return 'unreviewed';
  return changed ? 'changed' : 'agree';
}

export function Rail() {
  const scenarios = useStore((state: Store) => state.set[state.activeFile].scenarios);
  const activeFile = useStore((state) => state.activeFile);
  const activeScenarioId = useStore((state) => state.activeScenarioId);
  const selectScenario = useStore((state) => state.selectScenario);
  const openPanel = useStore((state) => state.openPanel);
  const overlay = useStore(activeOverlay);
  const overlays = useStore(allOverlays);
  const contested = useStore((state: Store) => contestedForFile(state, state.activeFile));
  const listRef = useRef<HTMLUListElement>(null);

  const proposals = useMemo(
    () => (overlay?.proposals ?? []).filter((proposal) => proposal.targetFile === activeFile),
    [overlay, activeFile],
  );

  const groups = useMemo(() => {
    const map = new Map<string, Scenario[]>();
    for (const scenario of scenarios) {
      const key = String(scenario.category);
      const bucket = map.get(key) ?? [];
      bucket.push(scenario);
      map.set(key, bucket);
    }
    return [...map.entries()];
  }, [scenarios]);

  // Keep the selected item in view when navigation comes from the keyboard.
  useEffect(() => {
    const selected = listRef.current?.querySelector('[aria-current="true"]');
    selected?.scrollIntoView({ block: 'nearest' });
  }, [activeScenarioId]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = scenarios.findIndex((scenario) => scenario.id === activeScenarioId);
    const next = event.key === 'ArrowDown' ? index + 1 : index - 1;
    if (next >= 0 && next < scenarios.length) selectScenario(scenarios[next].id);
  }

  const hardCaseIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of overlays) {
      for (const review of Object.values(entry.reviews)) {
        if (review.hardCase) ids.add(review.scenarioId);
      }
    }
    return ids;
  }, [overlays]);

  return (
    <nav
      aria-label="Scenarios"
      className="scroll-quiet flex h-full w-[280px] shrink-0 flex-col overflow-y-auto border-r"
      style={{ borderColor: 'var(--line)', background: 'var(--card)' }}
    >
      <ul ref={listRef} className="flex-1 py-2" onKeyDown={onKeyDown}>
        {groups.map(([category, items]) => (
          <li key={category}>
            <div className="flex items-baseline gap-1.5 px-4 pb-1 pt-4">
              <span className="eyebrow mono">{category}</span>
              {!isKnownCategory(activeFile, category) && (
                <span className="text-xs" style={{ color: 'var(--flag)' }} title="Category not in the original schema">
                  new
                </span>
              )}
            </div>
            <ul>
              {items.map((scenario) => {
                const review = overlay?.reviews[scenario.id];
                const changed =
                  review?.labelVerdict.kind === 'change' ||
                  review?.rationaleVerdict.kind === 'flawed' ||
                  review?.realismVerdict.kind === 'unrealistic';
                const selected = scenario.id === activeScenarioId;
                return (
                  <li key={scenario.id}>
                    <button
                      type="button"
                      aria-current={selected}
                      onClick={() => selectScenario(scenario.id)}
                      className="flex w-full items-start gap-2.5 px-4 py-2 text-left"
                      style={{
                        background: selected
                          ? 'color-mix(in srgb, var(--accent) 8%, var(--card))'
                          : 'transparent',
                        borderLeft: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                      }}
                    >
                      <span className="pt-1">
                        <StatusDot
                          state={dotState(Boolean(review), Boolean(changed))}
                          contested={contested.has(scenario.id)}
                          label={
                            contested.has(scenario.id)
                              ? 'Contested'
                              : review
                                ? changed
                                  ? 'Reviewed, with changes'
                                  : 'Reviewed, agreed'
                                : 'Not yet reviewed'
                          }
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-1.5">
                          <span className="mono text-sm font-medium">{scenario.id}</span>
                          {hardCaseIds.has(scenario.id) && <FlagGlyph title="Flagged as a hard case" />}
                          {isPreFlagged(scenario.id) && (
                            <span
                              className="text-xs"
                              style={{ color: 'var(--flag)' }}
                              title="Needs extra scrutiny"
                            >
                              ★
                            </span>
                          )}
                        </span>
                        <span
                          className="block truncate text-sm"
                          style={{ color: 'color-mix(in srgb, var(--ink) 65%, transparent)' }}
                          title={scenario.description}
                        >
                          {scenario.description}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}

        {proposals.length > 0 && (
          <li>
            <div className="px-4 pb-1 pt-5">
              <span className="eyebrow">Your proposed scenarios</span>
            </div>
            <ul>
              {proposals.map((proposal) => {
                const category = String(proposal.scenario.category ?? 'uncategorised');
                return (
                  <li key={proposal.tempId}>
                    <button
                      type="button"
                      className="flex w-full items-start gap-2.5 px-4 py-2 text-left"
                      onClick={() => openPanel({ kind: 'author', tempId: proposal.tempId })}
                    >
                      <span className="pt-1">
                        <StatusDot
                          state={proposal.status === 'submitted' ? 'agree' : 'unreviewed'}
                          label={proposal.status === 'submitted' ? 'Submitted' : 'Draft'}
                        />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="mono text-sm font-medium">
                            {proposal.assignedId ?? proposal.tempId}
                          </span>
                          <span className="chip text-xs">{proposal.status}</span>
                          {!isKnownCategory(proposal.targetFile, category) && (
                            <span
                              className="text-xs"
                              style={{ color: 'var(--flag)' }}
                              title={`New category: ${category}`}
                            >
                              new category
                            </span>
                          )}
                        </span>
                        <span className="mono block text-xs" style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
                          {category}
                        </span>
                        <span
                          className="block truncate text-sm"
                          style={{ color: 'color-mix(in srgb, var(--ink) 65%, transparent)' }}
                        >
                          {proposal.scenario.description || CATEGORY_GLOSS[category] || 'Untitled draft'}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </li>
        )}
      </ul>

      <div className="sticky bottom-0 border-t p-3" style={{ borderColor: 'var(--line)', background: 'var(--card)' }}>
        <button
          type="button"
          className="btn w-full"
          onClick={() => openPanel({ kind: 'author', tempId: '' })}
        >
          + New scenario
        </button>
      </div>
    </nav>
  );
}
