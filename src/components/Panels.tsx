// Spec §5.5 / §5.6 / §6 — export menu, agreement report, import, reviewer
// switching, and the import report. Modal surfaces, one shadow, no ceremony.

import { useMemo, useRef, useState } from 'react';
import { initials, todayIso } from '../lib/stamps';
import {
  buildReviewFile,
  canSaveToDisk,
  download,
  parseReviewFile,
  readTextFile,
  reviewFileName,
  ReviewFileError,
  saveToDisk,
} from '../lib/files';
import { clearAllReviewData, discardPending } from '../store/persist';
import { useSyncStore } from '../sync/useSyncStore';
import {
  activeOverlay,
  activeReviewer,
  agreementFor,
  mergedSummary,
  mergedYaml,
  progressFor,
  useStore,
  type Store,
} from '../store/useStore';
import { FILE_LABELS, FILE_NAMES, type FileKind } from '../types/scenario';
import { EmptyState, Eyebrow, Labelled, Modal } from './ui';

export function ExportPanel({ onClose }: { onClose: () => void }) {
  const overlay = useStore(activeOverlay);
  const reviewer = useStore(activeReviewer);
  const openPanel = useStore((state) => state.openPanel);
  const ownerMode = useStore((state) => state.ownerMode);
  const setOwnerMode = useStore((state) => state.setOwnerMode);
  const state = useStore((s: Store) => s);
  const [preview, setPreview] = useState<FileKind | null>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  // With a server, "reset" is a cache wipe rather than a deletion — but only
  // once the outbox is empty.
  const synced = useSyncStore((s) => s.status !== 'local');
  const unsent = useSyncStore((s) => s.pending);
  // Server role when there is one; the manual checkbox otherwise. Hiding is
  // cosmetic — /api/admin/* re-checks on every call.
  const serverRole = useSyncStore((s) => s.role);
  const isOwner = synced ? serverRole === 'owner' : ownerMode;

  async function exportYaml(kind: FileKind) {
    const text = mergedYaml(state, kind);
    const name = FILE_NAMES[kind];
    if (canSaveToDisk() && (await saveToDisk(name, text, 'YAML scenario file', '.yaml'))) return;
    download(name, text, 'text/yaml');
  }

  function exportReview() {
    if (!overlay) return;
    const iso = todayIso();
    download(reviewFileName(overlay, iso), buildReviewFile(overlay, iso), 'application/json');
  }

  const counts = useMemo(
    () => ({
      input: mergedSummary(state, 'input'),
      output: mergedSummary(state, 'output'),
    }),
    [state],
  );

  return (
    <Modal title="Export" onClose={onClose}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <Eyebrow>Your review</Eyebrow>
          <p className="text-base">
            The review file carries only your verdicts. Send it back to the project owner — this is
            what makes your work usable.
          </p>
          <button type="button" className="btn btn-primary self-start" onClick={exportReview} disabled={!overlay}>
            Export my review file
          </button>
          {reviewer && (
            <p className="mono text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 55%, transparent)' }}>
              {overlay ? reviewFileName(overlay, todayIso()) : ''}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
          <Eyebrow>Canonical files</Eyebrow>
          {/* Owner-only, and not as a policy choice — as arithmetic. A
              reviewer's overlays arrive blind-filtered, so a merge built from
              them would contain only their own verdicts. Unhiding this button
              produces a misleading file, not a leak. */}
          {!isOwner ? (
            <p className="text-base">
              The merged scenario files are produced by the project owner, once everyone's verdicts
              are in. Your own review file above is what you need.
            </p>
          ) : (
            <>
          <p className="text-base">
            The merged YAML carries every reviewer's verdicts. Contested changes export as notes
            until they are resolved — the answer key never moves by accident.
          </p>
          {(['input', 'output'] as FileKind[]).map((kind) => (
            <div key={kind} className="flex flex-wrap items-center gap-3">
              <button type="button" className="btn" onClick={() => exportYaml(kind)}>
                Export merged {FILE_LABELS[kind]} YAML
              </button>
              <span className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                {counts[kind].changed} scenario{counts[kind].changed === 1 ? '' : 's'} changed
                {counts[kind].appended > 0 ? `, ${counts[kind].appended} appended` : ''}
              </span>
              <button type="button" className="btn text-sm" onClick={() => setPreview(preview === kind ? null : kind)}>
                {preview === kind ? 'Hide preview' : 'Preview'}
              </button>
            </div>
          ))}
          {preview && (
            <pre
              className="scroll-quiet mono max-h-80 overflow-auto rounded-lg border px-3 py-2 text-sm"
              style={{ borderColor: 'var(--line)', background: 'var(--surface)' }}
            >
              {mergedYaml(state, preview)}
            </pre>
          )}
            </>
          )}
        </section>

        {/* Two different gates, deliberately not merged.

            Synced: the server says who the owner is, and the tools appear
            without asking. Local (file-only): there is no server role, so the
            self-declared checkbox is the only way in — and it must sit OUTSIDE
            the isOwner gate, or the control that enables owner mode is hidden
            behind owner mode. */}
        {!synced && (
          <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
            <Eyebrow>Owner tools</Eyebrow>
            <label className="chip cursor-pointer self-start">
              <input
                type="checkbox"
                checked={ownerMode}
                onChange={(event) => setOwnerMode(event.target.checked)}
                style={{ accentColor: 'var(--accent)' }}
              />
              Owner mode
            </label>
            {ownerMode && (
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn" onClick={() => openPanel({ kind: 'resolve' })}>
                  Resolve contested items
                </button>
                <button type="button" className="btn" onClick={() => openPanel({ kind: 'agreement' })}>
                  Agreement report
                </button>
              </div>
            )}
          </section>
        )}

        {synced && isOwner && (
          <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
            <Eyebrow>Owner tools</Eyebrow>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn" onClick={() => openPanel({ kind: 'dashboard' })}>
                Batch progress
              </button>
              <button type="button" className="btn" onClick={() => openPanel({ kind: 'people' })}>
                Manage counselors
              </button>
              <button type="button" className="btn" onClick={() => openPanel({ kind: 'resolve' })}>
                Resolve contested items
              </button>
              <button type="button" className="btn" onClick={() => openPanel({ kind: 'agreement' })}>
                Agreement report
              </button>
              <button type="button" className="btn" onClick={() => openPanel({ kind: 'promote' })}>
                Close batch and start the next
              </button>
            </div>
          </section>
        )}

        {/* Destructive and irreversible, so it sits behind its own divider and
            an inline confirm — never a one-click action next to the exports. */}
        <section className="flex flex-col gap-3 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
          <Eyebrow>Start over</Eyebrow>
          {confirmingReset ? (
            <div
              className="flex flex-col gap-3 rounded-card border px-4 py-3"
              style={{ borderColor: 'var(--flag)' }}
            >
              {/* Refuse while anything is unsent. Once work has reached the
                  server this is only a cache wipe and the next load restores
                  it — but clearing an outbox that has not drained destroys
                  verdicts that exist nowhere else. */}
              {unsent > 0 ? (
                <p className="text-base">
                  {unsent} {unsent === 1 ? 'verdict hasn' : 'verdicts haven'}'t reached the server
                  yet. Wait for the header to say Saved, or export your review file first — this
                  would delete them.
                </p>
              ) : (
                <p className="text-base">
                  This clears every reviewer, verdict, and resolution stored{' '}
                  <strong className="font-medium">in this browser</strong> and starts over from the
                  current scenario files. {synced ? 'Anything already synced comes back on the next load. ' : ''}
                  Exported files are not affected.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="btn"
                  disabled={unsent > 0}
                  style={{
                    borderColor: 'var(--flag)',
                    color: 'var(--flag)',
                    opacity: unsent > 0 ? 0.5 : 1,
                  }}
                  onClick={() => {
                    // Drop anything still debounced, or it would rewrite a key
                    // we are about to remove. Deliberately discard, not flush.
                    discardPending();
                    clearAllReviewData();
                    window.location.reload();
                  }}
                >
                  {synced ? 'Clear this browser and reload' : 'Delete everything and restart'}
                </button>
                <button type="button" className="btn" onClick={() => setConfirmingReset(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn self-start" onClick={() => setConfirmingReset(true)}>
              {synced ? 'Clear this browser' : 'Reset all review data'}
            </button>
          )}
        </section>
      </div>
    </Modal>
  );
}

export function AgreementPanel({ onClose }: { onClose: () => void }) {
  const [kind, setKind] = useState<FileKind>(useStore.getState().activeFile);
  const report = useStore((state: Store) => agreementFor(state, kind));
  const selectScenario = useStore((state) => state.selectScenario);
  const setActiveFile = useStore((state) => state.setActiveFile);
  const upsertProposal = useStore((state) => state.upsertProposal);
  const reviewer = useStore(activeReviewer);

  return (
    <Modal title="Agreement report" onClose={onClose} width="max-w-4xl">
      <div className="flex flex-col gap-6">
        <div className="flex gap-2">
          {(['input', 'output'] as FileKind[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={kind === option}
              className="btn"
              style={kind === option ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined}
              onClick={() => setKind(option)}
            >
              {FILE_LABELS[option]}
            </button>
          ))}
        </div>

        <section className="flex flex-wrap gap-6">
          <Stat label="Reviewed" value={String(report.reviewedCount)} />
          <Stat label="Reviewed twice or more" value={String(report.multiReviewedCount)} />
          <Stat
            label="Simple agreement"
            value={report.percent === null ? '—' : `${report.percent}%`}
          />
        </section>

        {report.byCategory.length > 0 && (
          <section className="flex flex-col gap-2">
            <Eyebrow>By category</Eyebrow>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left">
                  <th className="py-1 font-medium">Category</th>
                  <th className="py-1 font-medium">Compared</th>
                  <th className="py-1 font-medium">Agreed</th>
                  <th className="py-1 font-medium">Rate</th>
                </tr>
              </thead>
              <tbody>
                {report.byCategory.map((row) => (
                  <tr key={row.category} className="border-t" style={{ borderColor: 'var(--line)' }}>
                    <td className="mono py-1.5">{row.category}</td>
                    <td className="py-1.5 tabular-nums">{row.total}</td>
                    <td className="py-1.5 tabular-nums">{row.agreed}</td>
                    <td className="py-1.5 tabular-nums">{row.percent === null ? '—' : `${row.percent}%`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}

        <section className="flex flex-col gap-3">
          <Eyebrow>Where reviewers split</Eyebrow>
          {report.disagreements.length === 0 ? (
            <EmptyState>
              No disagreements yet. They appear once two reviewers answer the same scenario
              differently.
            </EmptyState>
          ) : (
            report.disagreements.map((entry) => (
              <article
                key={entry.scenario.id}
                className="rounded-card border px-4 py-3"
                style={{ borderColor: 'var(--flag)' }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="mono text-sm font-medium underline"
                    style={{ color: 'var(--accent)' }}
                    onClick={() => {
                      setActiveFile(kind);
                      selectScenario(entry.scenario.id);
                      onClose();
                    }}
                  >
                    {entry.scenario.id}
                  </button>
                  <span className="mono text-sm">{String(entry.scenario.category)}</span>
                </div>
                <ul className="mt-2 flex flex-col gap-1 text-sm">
                  {entry.labels.map((label) => (
                    <li key={label.reviewerId}>
                      <span className="font-medium">{initials(label.displayName)}</span>{' '}
                      {label.agreed ? 'agreed with' : 'proposed'} <span className="mono">{label.label}</span>
                      {label.because && (
                        <span style={{ color: 'color-mix(in srgb, var(--ink) 68%, transparent)' }}>
                          {' '}
                          — {label.because}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {String(entry.scenario.category) !== 'ambiguous_boundary' && kind === 'input' && reviewer && (
                  <button
                    type="button"
                    className="btn mt-3 text-sm"
                    onClick={() => {
                      // `kind` is the discriminant on Scenario; a proposal is a
                      // partial draft and carries neither it nor an id yet.
                      const { kind: _kind, id: _id, ...draft } = entry.scenario;
                      upsertProposal({
                        tempId: `recat-${entry.scenario.id}`,
                        targetFile: 'input',
                        authorId: reviewer.id,
                        status: 'draft',
                        scenario: {
                          ...draft,
                          category: 'ambiguous_boundary',
                          description: `Recategorisation of ${entry.scenario.id}: licensed reviewers split on the tier.`,
                        },
                      });
                    }}
                  >
                    Suggest recategorisation as ambiguous_boundary
                  </button>
                )}
              </article>
            ))
          )}
        </section>
      </div>
    </Modal>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <p className="text-lg tabular-nums">{value}</p>
    </div>
  );
}

export function ImportPanel({ onClose }: { onClose: () => void }) {
  const importYaml = useStore((state) => state.importYaml);
  const importOverlay = useStore((state) => state.importOverlay);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return;
    setError(null);
    const yamlFiles: Array<{ name: string; text: string }> = [];
    for (const file of Array.from(fileList)) {
      const text = await readTextFile(file);
      if (/\.review\.json$/i.test(file.name) || /"format"\s*:\s*"srs\.review"/.test(text)) {
        try {
          importOverlay(parseReviewFile(text));
        } catch (cause) {
          setError(cause instanceof ReviewFileError ? cause.message : String(cause));
        }
      } else {
        yamlFiles.push({ name: file.name, text });
      }
    }
    if (yamlFiles.length > 0) importYaml(yamlFiles);
    if (!error) onClose();
  }

  return (
    <Modal title="Import files" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="text-base">
          Drop the two scenario YAML files to replace the built-in set, or another reviewer's
          <span className="mono"> .review.json</span> to bring their verdicts into this workspace.
        </p>

        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void handleFiles(event.dataTransfer.files);
          }}
          className="rounded-card border-2 border-dashed px-6 py-10 text-center"
          style={{
            borderColor: dragging ? 'var(--accent)' : 'var(--line)',
            background: dragging ? 'color-mix(in srgb, var(--accent) 5%, var(--card))' : 'var(--surface)',
          }}
        >
          <p className="text-base">Drop files here</p>
          <p className="mt-1 text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
            or
          </p>
          <button type="button" className="btn mt-3" onClick={() => inputRef.current?.click()}>
            Choose files
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept=".yaml,.yml,.json"
            className="sr-only"
            onChange={(event) => void handleFiles(event.target.files)}
          />
        </div>

        {error && (
          <p className="rounded-lg border px-3 py-2 text-sm" style={{ borderColor: 'var(--flag)', color: 'var(--flag)' }}>
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function ImportReportPanel() {
  const report = useStore((state) => state.importReport);
  const dismiss = useStore((state) => state.dismissImportReport);
  if (!report) return null;

  return (
    <Modal title="Import report" onClose={dismiss}>
      <div className="flex flex-col gap-5">
        {report.files.length > 0 && (
          <section>
            <Eyebrow>Loaded</Eyebrow>
            <ul className="mt-2 flex flex-col gap-1 text-base">
              {report.files.map((file) => (
                <li key={file.name}>
                  <span className="mono">{file.name}</span> — {file.count} scenarios into{' '}
                  {FILE_LABELS[file.kind]}
                </li>
              ))}
            </ul>
          </section>
        )}

        {report.errors.length > 0 && (
          <section>
            <Eyebrow>Couldn't be read</Eyebrow>
            <ul className="mt-2 flex flex-col gap-1 text-base" style={{ color: 'var(--flag)' }}>
              {report.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <Eyebrow>Warnings</Eyebrow>
          {report.warnings.length === 0 ? (
            <EmptyState>Nothing to flag — both files matched the expected shape.</EmptyState>
          ) : (
            <ul className="mt-2 flex flex-col gap-1 text-base">
              {report.warnings.map((warning, index) => (
                <li key={index}>
                  {warning.scenarioId && <span className="mono">{warning.scenarioId}: </span>}
                  {warning.message}
                </li>
              ))}
            </ul>
          )}
        </section>

        <button type="button" className="btn btn-primary self-start" onClick={dismiss}>
          Continue reviewing
        </button>
      </div>
    </Modal>
  );
}

export function SwitchReviewerPanel({ onClose }: { onClose: () => void }) {
  const reviewers = useStore((state) => state.reviewers);
  const activeId = useStore((state) => state.activeReviewerId);
  const switchReviewer = useStore((state) => state.switchReviewer);
  const signIn = useStore((state) => state.signIn);
  const state = useStore((s: Store) => s);
  const [name, setName] = useState('');
  const [credentials, setCredentials] = useState('');

  return (
    <Modal title="Reviewers" onClose={onClose}>
      <div className="flex flex-col gap-6">
        <section className="flex flex-col gap-2">
          <Eyebrow>In this workspace</Eyebrow>
          {reviewers.map((reviewer) => {
            const progress = progressFor({ ...state, activeReviewerId: reviewer.id }, state.activeFile);
            return (
              <button
                key={reviewer.id}
                type="button"
                className="flex items-center justify-between rounded-lg border px-4 py-2 text-left"
                style={{
                  borderColor: reviewer.id === activeId ? 'var(--accent)' : 'var(--line)',
                }}
                onClick={() => {
                  switchReviewer(reviewer.id);
                  onClose();
                }}
              >
                <span>
                  <span className="font-medium">{reviewer.displayName}</span>
                  {reviewer.credentials && (
                    <span style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                      {' '}
                      ({reviewer.credentials})
                    </span>
                  )}
                </span>
                <span className="text-sm tabular-nums" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
                  {progress.done}/{progress.total}
                </span>
              </button>
            );
          })}
        </section>

        <form
          className="flex flex-col gap-3 border-t pt-5"
          style={{ borderColor: 'var(--line)' }}
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim().length >= 2) {
              signIn(name, credentials);
              onClose();
            }
          }}
        >
          <Eyebrow>Add a reviewer</Eyebrow>
          <Labelled label="Name" htmlFor="switch-name">
            <input
              id="switch-name"
              className="field"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Marcus Kane"
            />
          </Labelled>
          <Labelled label="Credentials" htmlFor="switch-credentials">
            <input
              id="switch-credentials"
              className="field"
              value={credentials}
              onChange={(event) => setCredentials(event.target.value)}
              placeholder="PsyD"
            />
          </Labelled>
          <button type="submit" className="btn btn-primary self-start" disabled={name.trim().length < 2}>
            Add reviewer
          </button>
        </form>
      </div>
    </Modal>
  );
}
