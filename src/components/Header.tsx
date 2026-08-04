// Spec §5.2 — app name · file toggle · progress ring · reviewer chip · Export menu.

import {
  activeReviewer,
  progressFor,
  useStore,
  type Store,
} from '../store/useStore';
import { FILE_LABELS, type FileKind } from '../types/scenario';
import { ProgressRing } from './ui';

export function Header() {
  const activeFile = useStore((state) => state.activeFile);
  const setActiveFile = useStore((state) => state.setActiveFile);
  const openPanel = useStore((state) => state.openPanel);
  const reviewer = useStore(activeReviewer);
  const counts = useStore((state: Store) => ({
    input: state.set.input.scenarios.length,
    output: state.set.output.scenarios.length,
  }));
  const progress = useStore((state: Store) => progressFor(state, state.activeFile));
  const imported = useStore((state) => state.imported);

  return (
    <header
      className="sticky top-0 z-30 flex flex-wrap items-center gap-x-6 gap-y-3 border-b px-5 py-3"
      style={{ borderColor: 'var(--line)', background: 'var(--card)' }}
    >
      <div className="flex items-baseline gap-3">
        <h1 className="text-md font-semibold" style={{ fontFamily: "'Schibsted Grotesk', sans-serif" }}>
          Scenario Review Studio
        </h1>
        {!imported && (
          <span className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
            built-in scenarios
          </span>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Scenario file"
        className="flex overflow-hidden rounded-lg border"
        style={{ borderColor: 'var(--line)' }}
      >
        {(['input', 'output'] as FileKind[]).map((kind) => {
          const selected = activeFile === kind;
          return (
            <button
              key={kind}
              role="tab"
              type="button"
              aria-selected={selected}
              className="px-3 py-1.5 text-sm font-medium"
              style={{
                background: selected ? 'var(--accent)' : 'transparent',
                color: selected ? '#fff' : 'var(--ink)',
              }}
              onClick={() => setActiveFile(kind)}
            >
              {FILE_LABELS[kind]} {counts[kind]}
            </button>
          );
        })}
      </div>

      <ProgressRing done={progress.done} total={progress.total} />

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          className="chip"
          onClick={() => openPanel({ kind: 'switch-reviewer' })}
          title="Switch reviewer or add another"
        >
          <span
            aria-hidden="true"
            className="h-2 w-2 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
          Reviewing as {reviewer?.displayName ?? 'unknown'} — switch
        </button>
        <button type="button" className="btn" onClick={() => openPanel({ kind: 'import' })}>
          Import files
        </button>
        <button type="button" className="btn btn-primary" onClick={() => openPanel({ kind: 'export' })}>
          Export
        </button>
      </div>
    </header>
  );
}
