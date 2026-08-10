// Close the batch and start the next one, in a single step.
//
// The merge runs HERE, in the browser, via exportMergedYaml — exactly as it
// does for a normal export. The server only archives the resulting bytes and
// makes them the next batch's canon. It never merges anything, which is what
// keeps §3's "merging happens only at export time" literally true even though
// a database now exists.
//
// Without this, the loop would be: export a file, keep track of it, upload it
// again, remember to close the batch, remember to enrol the next group. Five
// manual steps with a live chance of promoting the wrong file.

import { useState } from 'react';
import { admin } from '../sync/admin';
import { fileHash } from '../store/persist';
import { mergedSummary, mergedYaml, useStore, type Store } from '../store/useStore';
import { useSyncStore } from '../sync/useSyncStore';
import { download } from '../lib/files';
import { FILE_NAMES } from '../types/scenario';
import { Eyebrow, Labelled, Modal } from './ui';

export function PromotePanel({ onClose }: { onClose: () => void }) {
  const state = useStore((s: Store) => s);
  const [nextLabel, setNextLabel] = useState('');
  const [confirm, setConfirm] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ closed: string; opened: string } | null>(null);

  const roundLabel = useSyncStore((s) => s.roundLabel) ?? '';
  const input = mergedSummary(state, 'input');
  const output = mergedSummary(state, 'output');
  const touched = input.changed + output.changed + input.appended + output.appended;

  async function promote() {
    setBusy(true);
    setError(null);
    try {
      // Same call the ordinary export makes — one merge implementation.
      const inputYaml = mergedYaml(state, 'input');
      const outputYaml = mergedYaml(state, 'output');

      const result = await admin.promote({
        inputYaml,
        outputYaml,
        fileHash: fileHash(inputYaml, outputYaml),
        scenarioIds: {
          input: state.set.input.scenarios.map((s) => s.id),
          output: state.set.output.scenarios.map((s) => s.id),
        },
        nextLabel: nextLabel.trim(),
        confirm: confirm.trim(),
        note: note.trim() || undefined,
      });
      setDone({ closed: result.closed.label, opened: result.opened.label });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not promote.');
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Modal title="Batch closed" onClose={onClose}>
        <div className="flex flex-col gap-4">
          <p className="text-base">
            <strong className="font-medium">{done.closed}</strong> is closed and{' '}
            <strong className="font-medium">{done.opened}</strong> is open on the merged canon. The
            exported YAML is archived against the closed batch, so an eval run can always be traced
            back to exact bytes.
          </p>
          <p className="text-base">
            Nobody is enrolled in the new batch yet. Add counselors when you're ready — returning
            ones keep the link they already have.
          </p>
          <button type="button" className="btn btn-primary self-start" onClick={onClose}>
            Done
          </button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title="Close batch and start the next" onClose={onClose}>
      <div className="flex flex-col gap-5">
        <p className="text-base">
          This merges every verdict and resolution in{' '}
          <strong className="font-medium">{roundLabel || 'this batch'}</strong> into the scenario
          files, archives those exact bytes, and opens a new batch on the result. Contested items
          you haven't resolved export as notes rather than changed labels.
        </p>

        <section className="flex flex-wrap gap-x-8 gap-y-2">
          <div>
            <Eyebrow>Input scenarios changed</Eyebrow>
            <p className="text-lg tabular-nums">
              {input.changed}
              {input.appended > 0 ? ` (+${input.appended} new)` : ''}
            </p>
          </div>
          <div>
            <Eyebrow>Output scenarios changed</Eyebrow>
            <p className="text-lg tabular-nums">
              {output.changed}
              {output.appended > 0 ? ` (+${output.appended} new)` : ''}
            </p>
          </div>
        </section>

        {touched === 0 && (
          <p className="text-base" style={{ color: 'var(--flag)' }}>
            Nothing has changed, so the next batch would review an identical file. Resolve some
            contested items first, or close the batch without promoting.
          </p>
        )}

        {/* Downloading first is not required, but it is the sane order: look
            at the diff before it becomes the canon everyone reviews next. */}
        <section className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn"
            onClick={() => download(FILE_NAMES.input, mergedYaml(state, 'input'), 'text/yaml')}
          >
            Download merged input file
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => download(FILE_NAMES.output, mergedYaml(state, 'output'), 'text/yaml')}
          >
            Download merged output file
          </button>
        </section>

        <section className="flex flex-col gap-4 border-t pt-5" style={{ borderColor: 'var(--line)' }}>
          <Labelled label="Name for the next batch" htmlFor="next-label">
            <input
              id="next-label"
              className="field"
              value={nextLabel}
              placeholder="Batch 2"
              onChange={(e) => setNextLabel(e.target.value)}
            />
          </Labelled>

          <Labelled label="Note for the archive (optional)" htmlFor="promote-note">
            <input
              id="promote-note"
              className="field"
              value={note}
              placeholder="eval run 2026-08-14"
              onChange={(e) => setNote(e.target.value)}
            />
          </Labelled>

          <Labelled label={`Type "${roundLabel}" to confirm`} htmlFor="promote-confirm">
            <input
              id="promote-confirm"
              className="field"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </Labelled>
          <p className="text-sm" style={{ color: 'color-mix(in srgb, var(--ink) 60%, transparent)' }}>
            Closing a batch ends everyone's session in it. Typing the name is the confirmation
            because this isn't reversible from here.
          </p>
        </section>

        {error && (
          <p className="text-base" style={{ color: 'var(--flag)' }}>
            {error}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || !nextLabel.trim() || confirm.trim() !== roundLabel}
            onClick={() => void promote()}
          >
            {busy ? 'Promoting…' : 'Close batch and open the next'}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}
