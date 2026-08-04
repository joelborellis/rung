// Spec §4.3 B — the canonical export.
//
// merge.ts produces the merged *model*. This module diffs that model against
// the imported one, turns the differences into a line patch, and applies it to
// the original file text. Anything the reviewers did not touch is copied
// through verbatim, whatever style it was written in.

import type { Resolution, ReviewOverlay } from '../types/review';
import type { Scenario, ScenarioFile } from '../types/scenario';
import { mergeFile } from './merge';
import { applyPatch, type FilePatch, type ScenarioPatch } from './yaml/patch';
import { scanFile } from './yaml/source';

/** Fields the export is ever allowed to rewrite in place. */
const PROSE_FIELDS = ['description', 'rationale', 'feedback', 'reason'] as const;

function sameNotes(a: Scenario['reviewer_notes'], b: Scenario['reviewer_notes']): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

export function buildPatch(original: ScenarioFile, merged: ScenarioFile): FilePatch {
  const byId = new Map(original.scenarios.map((scenario) => [scenario.id, scenario]));
  const scenarios: ScenarioPatch[] = [];
  const append: Scenario[] = [];

  for (const next of merged.scenarios) {
    const before = byId.get(next.id);
    if (!before) {
      append.push(next);
      continue;
    }

    const patch: ScenarioPatch = { id: next.id, fields: {} };

    if (before.reviewed_by !== next.reviewed_by) {
      patch.fields.reviewed_by = { style: 'inline', value: next.reviewed_by };
    }

    if (before.kind === 'input' && next.kind === 'input') {
      if (before.expected_tier !== next.expected_tier) {
        patch.fields.expected_tier = { style: 'inline', value: String(next.expected_tier) };
      }
    }
    if (before.kind === 'output' && next.kind === 'output') {
      if (before.expected_result !== next.expected_result) {
        patch.fields.expected_result = { style: 'bool', value: next.expected_result };
      }
    }

    for (const key of PROSE_FIELDS) {
      const a = (before as unknown as Record<string, unknown>)[key];
      const b = (next as unknown as Record<string, unknown>)[key];
      if (typeof b === 'string' && a !== b) {
        patch.fields[key] = { style: 'prose', value: b };
      }
    }

    if (!sameNotes(before.reviewer_notes, next.reviewer_notes)) {
      patch.reviewerNotes = next.reviewer_notes ?? [];
    }

    if (Object.keys(patch.fields).length > 0 || patch.reviewerNotes !== undefined) {
      scenarios.push(patch);
    }
  }

  return { scenarios, append };
}

export type ExportInput = {
  file: ScenarioFile;
  overlays: ReviewOverlay[];
  resolutions: Record<string, Resolution>;
  now?: string;
};

/** The merged YAML, as text, ready to download. */
export function exportMergedYaml({ file, overlays, resolutions, now }: ExportInput): string {
  const merged = mergeFile({ file, overlays, resolutions, now });
  const patch = buildPatch(file, merged);
  return applyPatch(scanFile(file.source), patch);
}

/** How many scenarios the export will touch — shown before download. */
export function exportSummary({ file, overlays, resolutions, now }: ExportInput): {
  changed: number;
  appended: number;
} {
  const merged = mergeFile({ file, overlays, resolutions, now });
  const patch = buildPatch(file, merged);
  return { changed: patch.scenarios.length, appended: patch.append.length };
}
