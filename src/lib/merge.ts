// Spec §4.3 B — merge the overlays into the canon at export time, and only at
// export time. The rule that shapes this whole file: a `change` verdict never
// silently rewrites expected_tier / expected_result. It becomes a
// reviewer_notes entry, and the field moves only once the owner has resolved
// it in the resolution view.

import type {
  ProposedScenario,
  Resolution,
  ReviewOverlay,
  ScenarioReview,
} from '../types/review';
import { resolutionKey } from '../types/review';
import type {
  FileKind,
  InputScenario,
  OutputScenario,
  ReviewerNote,
  Scenario,
  ScenarioFile,
} from '../types/scenario';
import { appendStamp, authoredStamp, buildStamp, isoDate, reviewerMark } from './stamps';

export type MergeInput = {
  file: ScenarioFile;
  overlays: ReviewOverlay[];
  resolutions: Record<string, Resolution>;
  /** Date used for AUTHORED stamps when a proposal carries none. */
  now?: string;
};

/** Everything one reviewer said about one scenario, paired with its overlay. */
type Entry = { overlay: ReviewOverlay; review: ScenarioReview };

function entriesFor(scenarioId: string, overlays: ReviewOverlay[]): Entry[] {
  return overlays
    .map((overlay) => ({ overlay, review: overlay.reviews[scenarioId] }))
    .filter((entry): entry is Entry => Boolean(entry.review))
    .sort((a, b) => a.review.reviewedAt.localeCompare(b.review.reviewedAt));
}

function noteStatus(
  resolution: Resolution | undefined,
): ReviewerNote['status'] {
  if (!resolution) return 'contested';
  if (resolution.decision === 'accept') return 'accepted';
  return 'rejected';
}

function buildNotes(
  scenario: Scenario,
  entries: Entry[],
  resolutions: Record<string, Resolution>,
): ReviewerNote[] {
  const notes: ReviewerNote[] = [];
  for (const { overlay, review } of entries) {
    const who = reviewerMark(overlay.reviewer);
    const date = isoDate(review.reviewedAt);

    if (review.labelVerdict.kind === 'change') {
      const resolution = resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'label')];
      const note: ReviewerNote = {
        reviewer: who,
        date,
        concern: 'label',
        because: review.labelVerdict.because,
        status: noteStatus(resolution),
      };
      if (scenario.kind === 'input') {
        note.proposed_tier = String(review.labelVerdict.proposed);
      } else {
        note.proposed_result = review.labelVerdict.proposed === true;
      }
      notes.push(note);
    }

    if (review.rationaleVerdict.kind === 'flawed') {
      notes.push({
        reviewer: who,
        date,
        concern: 'rationale',
        because: review.rationaleVerdict.because,
        status: noteStatus(resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'rationale')]),
      });
    }

    if (review.realismVerdict.kind === 'unrealistic') {
      notes.push({
        reviewer: who,
        date,
        concern: 'realism',
        because: review.realismVerdict.because,
        status: noteStatus(resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'realism')]),
      });
    }
  }
  return notes;
}

function applyAcceptedLabel(
  scenario: Scenario,
  entries: Entry[],
  resolutions: Record<string, Resolution>,
): Scenario {
  // Last accepted resolution wins; there is only ever one in practice because
  // the resolution view accepts a single proposal per scenario.
  let result = scenario;
  for (const { overlay, review } of entries) {
    if (review.labelVerdict.kind !== 'change') continue;
    const resolution = resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'label')];
    if (!resolution) continue;
    if (resolution.decision === 'accept') {
      const proposed = review.labelVerdict.proposed;
      result =
        result.kind === 'input'
          ? { ...result, expected_tier: String(proposed) }
          : { ...result, expected_result: proposed === true };
    } else if (resolution.decision === 'manual' && resolution.manualValue !== undefined) {
      result =
        result.kind === 'input'
          ? { ...result, expected_tier: String(resolution.manualValue) }
          : { ...result, expected_result: resolution.manualValue === true };
    }
  }
  return result;
}

function applyAcceptedTextEdits(
  scenario: Scenario,
  entries: Entry[],
  resolutions: Record<string, Resolution>,
): Scenario {
  let result = scenario;
  for (const { overlay, review } of entries) {
    const edits = review.proposedTextEdits;
    if (!edits || Object.keys(edits).length === 0) continue;
    const resolution = resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'text')];
    if (resolution?.decision !== 'accept') continue;
    if (edits.description !== undefined) {
      result = { ...result, description: edits.description };
    }
    if (result.kind === 'input' && edits.rationale !== undefined) {
      result = { ...result, rationale: edits.rationale } as InputScenario;
    }
    if (result.kind === 'output' && edits.feedback !== undefined) {
      result = { ...result, feedback: edits.feedback } as OutputScenario;
    }
  }
  return result;
}

/** A submitted, owner-accepted proposal becomes a real scenario. */
export function materialiseProposal(
  proposal: ProposedScenario,
  overlay: ReviewOverlay,
  fallbackIso: string,
): Scenario | null {
  const id = proposal.assignedId?.trim();
  if (!id) return null;
  const draft = proposal.scenario;
  const base = {
    id,
    category: draft.category ?? 'uncategorised',
    description: draft.description ?? '',
    context: {
      assigned_exercise: draft.context?.assigned_exercise ?? '',
      hierarchy_position: draft.context?.hierarchy_position ?? '',
      scope_notes: draft.context?.scope_notes ?? '',
    },
    conversation: draft.conversation ?? [],
    reviewed_by: authoredStamp(overlay.reviewer, fallbackIso),
  };
  if (proposal.targetFile === 'input') {
    return {
      ...base,
      kind: 'input',
      expected_tier: draft.expected_tier ?? 'no_issue',
      rationale: draft.rationale ?? '',
    };
  }
  return {
    ...base,
    kind: 'output',
    expected_result: draft.expected_result === true,
    reason: draft.reason ?? '',
    feedback: draft.feedback ?? '',
  };
}

export function mergeFile({ file, overlays, resolutions, now }: MergeInput): ScenarioFile {
  const stampDate = now ?? new Date().toISOString();
  const merged = file.scenarios.map((scenario) => {
    const entries = entriesFor(scenario.id, overlays);
    if (entries.length === 0) return scenario;

    let result = applyAcceptedLabel(scenario, entries, resolutions);
    result = applyAcceptedTextEdits(result, entries, resolutions);

    let reviewed = result.reviewed_by;
    for (const { overlay, review } of entries) {
      reviewed = appendStamp(reviewed, buildStamp(overlay.reviewer, review, file.kind));
    }

    const notes = [...(scenario.reviewer_notes ?? []), ...buildNotes(scenario, entries, resolutions)];
    return {
      ...result,
      reviewed_by: reviewed,
      reviewer_notes: notes.length > 0 ? notes : undefined,
    } as Scenario;
  });

  const appended: Scenario[] = [];
  for (const overlay of overlays) {
    for (const proposal of overlay.proposals) {
      if (proposal.targetFile !== file.kind) continue;
      if (proposal.status !== 'submitted' || proposal.accepted !== true) continue;
      const scenario = materialiseProposal(proposal, overlay, stampDate);
      if (scenario) appended.push(scenario);
    }
  }

  return { ...file, scenarios: [...merged, ...appended] };
}

/** Scenarios whose label is disputed — by a change verdict or between reviewers. */
export function contestedIds(
  file: ScenarioFile,
  overlays: ReviewOverlay[],
  resolutions: Record<string, Resolution>,
): Set<string> {
  const ids = new Set<string>();
  for (const scenario of file.scenarios) {
    const entries = entriesFor(scenario.id, overlays);
    const unresolvedChange = entries.some(({ overlay, review }) => {
      if (review.labelVerdict.kind !== 'change') return false;
      return !resolutions[resolutionKey(scenario.id, overlay.reviewer.id, 'label')];
    });
    if (unresolvedChange) {
      ids.add(scenario.id);
      continue;
    }
    // Two reviewers who both answered, but not with the same label.
    const labels = entries.map(({ review }) =>
      review.labelVerdict.kind === 'agree'
        ? currentLabel(scenario)
        : String(review.labelVerdict.proposed),
    );
    if (new Set(labels).size > 1) ids.add(scenario.id);
  }
  return ids;
}

export function currentLabel(scenario: Scenario): string {
  return scenario.kind === 'input'
    ? String(scenario.expected_tier)
    : String(scenario.expected_result);
}

export function labelFor(kind: FileKind, value: unknown): string {
  if (kind === 'input') return String(value);
  return value === true || value === 'true' ? 'pass' : 'fail';
}
