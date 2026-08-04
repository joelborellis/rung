// Spec §4.3 — apply the overlay to the original file text, touching only the
// lines that changed. Untouched scenarios come out byte-identical because they
// are never re-serialised: their original lines are copied through.

import type { ReviewerNote, Scenario } from '../../types/scenario';
import { blockScalar, emitReviewerNotes, emitScenario, token } from './emit';
import { findItem, type FileSource } from './source';

export type FieldPatch =
  | { style: 'inline'; value: string }
  | { style: 'bool'; value: boolean }
  | { style: 'prose'; value: string };

export type ScenarioPatch = {
  id: string;
  fields: Record<string, FieldPatch>;
  /** Replaces an existing reviewer_notes block, or is inserted after reviewed_by. */
  reviewerNotes?: ReviewerNote[];
};

export type FilePatch = {
  scenarios: ScenarioPatch[];
  append: Scenario[];
};

type Splice = { start: number; end: number; lines: string[] };

function renderField(key: string, patch: FieldPatch, indent: number): string[] {
  const pad = ' '.repeat(indent);
  if (patch.style === 'bool') return [`${pad}${key}: ${patch.value ? 'true' : 'false'}`];
  if (patch.style === 'inline') return [`${pad}${key}: ${token(patch.value)}`];
  const [head, ...rest] = blockScalar(patch.value, indent / 2 + 1);
  return [`${pad}${key}: ${head}`, ...rest];
}

export function applyPatch(source: FileSource, patch: FilePatch): string {
  const splices: Splice[] = [];

  for (const scenarioPatch of patch.scenarios) {
    const item = findItem(source, scenarioPatch.id);
    if (!item) continue;

    for (const [key, fieldPatch] of Object.entries(scenarioPatch.fields)) {
      const span = item.fields[key];
      const lines = renderField(key, fieldPatch, span?.indent ?? item.keyIndent);
      if (span) {
        splices.push({ start: span.start, end: span.end, lines });
      } else {
        // The field is absent upstream — add it after reviewed_by, or at the
        // end of the scenario if there is no reviewed_by either.
        const anchor = item.fields.reviewed_by ?? item.fields[Object.keys(item.fields).pop() ?? 'id'];
        splices.push({ start: anchor.end + 1, end: anchor.end, lines });
      }
    }

    if (scenarioPatch.reviewerNotes !== undefined) {
      const existing = item.fields.reviewer_notes;
      const rendered =
        scenarioPatch.reviewerNotes.length === 0
          ? []
          : emitReviewerNotes(scenarioPatch.reviewerNotes, item.keyIndent / 2);
      if (existing) {
        splices.push({ start: existing.start, end: existing.end, lines: rendered });
      } else if (rendered.length > 0) {
        const anchor = item.fields.reviewed_by;
        const at = anchor ? anchor.end + 1 : item.end + 1;
        splices.push({ start: at, end: at - 1, lines: rendered });
      }
    }
  }

  if (patch.append.length > 0) {
    const lines: string[] = [];
    for (const scenario of patch.append) {
      if (source.blankBetweenItems) lines.push('');
      lines.push(...emitScenario(scenario, source.itemIndent));
    }
    splices.push({ start: source.appendAt, end: source.appendAt - 1, lines });
  }

  // Apply back-to-front so earlier indices stay valid.
  splices.sort((a, b) => b.start - a.start || b.end - a.end);
  const out = [...source.lines];
  for (const splice of splices) {
    out.splice(splice.start, splice.end - splice.start + 1, ...splice.lines);
  }

  return out.join('\n') + (source.trailingNewline ? '\n' : '');
}
