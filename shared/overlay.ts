// The overlay <-> rows boundary, and the one conflict comparator.
//
// This is the leverage point for the Postgres backend: the database stores a
// ReviewOverlay decomposed into rows and reassembles the byte-identical object
// on read. Because a reassembled overlay is indistinguishable from one parsed
// out of a `.review.json`, merge.ts / agreement.ts / export.ts never learn that
// a server exists, and "merging happens only at export time" (§3) stays
// literally true.
//
// Two identities this file must preserve exactly, both load-bearing and both
// silent when broken:
//   - `reviewedAt` as a STRING. merge.ts sorts reviewers with localeCompare and
//     stamps.ts slices the first 10 chars into the YAML. A timestamp that
//     round-trips through Date and back reformats, changing merge precedence
//     and stamp dates without any error.
//   - `manualValue` as a boolean when it was a boolean. merge.ts compares it
//     with `=== true`; stored as text it becomes 'true' and silently stops
//     applying.

import type {
  ProposedScenario,
  ProposedTextEdits,
  RationaleVerdict,
  RealismVerdict,
  Reviewer,
  ReviewOverlay,
  ScenarioReview,
  Verdict,
  LabelValue,
} from './review';
import type { FileKind } from './scenario';

/** One `reviews` row. Mirrors the table; jsonb columns stay verbatim. */
export type ReviewRow = {
  roundId: string;
  personId: string;
  scenarioId: string;
  fileKind: FileKind;
  /** Verbatim client bytes — never a re-formatted timestamp. */
  reviewedAtIso: string;
  labelVerdict: Verdict<LabelValue>;
  rationaleVerdict: RationaleVerdict;
  realismVerdict: RealismVerdict;
  hardCase: boolean;
  comment: string | null;
  proposedTextEdits: ProposedTextEdits | null;
};

/** One `proposals` row. */
export type ProposalRow = {
  roundId: string;
  authorId: string;
  tempId: string;
  targetFile: FileKind;
  status: 'draft' | 'submitted';
  scenario: ProposedScenario['scenario'];
  assignedId: string | null;
  accepted: boolean | null;
};

export type OverlayRows = {
  reviews: ReviewRow[];
  proposals: ProposalRow[];
};

export type ToRowsContext = {
  roundId: string;
  /**
   * Which file a scenario belongs to. The scenario id does not carry it, and
   * the server must never parse YAML to find out, so the client supplies it.
   * Reviews for unknown ids are dropped rather than guessed — see the return
   * value of `overlayToRows`.
   */
  fileKindOf: (scenarioId: string) => FileKind | undefined;
};

/**
 * Decompose an overlay into rows. Returns the rows plus any scenario ids that
 * could not be placed in a file, so the caller can surface them instead of
 * losing verdicts quietly.
 */
export function overlayToRows(
  overlay: ReviewOverlay,
  { roundId, fileKindOf }: ToRowsContext,
): OverlayRows & { unplaced: string[] } {
  const reviews: ReviewRow[] = [];
  const unplaced: string[] = [];

  for (const review of Object.values(overlay.reviews)) {
    const fileKind = fileKindOf(review.scenarioId);
    if (!fileKind) {
      unplaced.push(review.scenarioId);
      continue;
    }
    reviews.push({
      roundId,
      personId: review.reviewerId,
      scenarioId: review.scenarioId,
      fileKind,
      reviewedAtIso: review.reviewedAt,
      labelVerdict: review.labelVerdict,
      rationaleVerdict: review.rationaleVerdict,
      realismVerdict: review.realismVerdict,
      hardCase: review.hardCase,
      comment: review.comment ?? null,
      proposedTextEdits: review.proposedTextEdits ?? null,
    });
  }

  const proposals: ProposalRow[] = overlay.proposals.map((proposal) => ({
    roundId,
    authorId: proposal.authorId,
    tempId: proposal.tempId,
    targetFile: proposal.targetFile,
    status: proposal.status,
    scenario: proposal.scenario,
    assignedId: proposal.assignedId ?? null,
    accepted: proposal.accepted ?? null,
  }));

  return { reviews, proposals, unplaced };
}

/**
 * Reassemble an overlay from rows. Optional fields that were absent must stay
 * absent, not come back as explicit `undefined` — the round-trip test asserts
 * strict equality, and a `.review.json` should not grow null keys by making a
 * trip through the database.
 */
export function rowsToOverlay(
  reviewer: Reviewer,
  { reviews, proposals }: OverlayRows,
): ReviewOverlay {
  const map: Record<string, ScenarioReview> = {};

  for (const row of reviews) {
    const review: ScenarioReview = {
      scenarioId: row.scenarioId,
      reviewerId: row.personId,
      reviewedAt: row.reviewedAtIso,
      labelVerdict: row.labelVerdict,
      rationaleVerdict: row.rationaleVerdict,
      realismVerdict: row.realismVerdict,
      hardCase: row.hardCase,
    };
    if (row.comment !== null) review.comment = row.comment;
    if (row.proposedTextEdits !== null) review.proposedTextEdits = row.proposedTextEdits;
    map[row.scenarioId] = review;
  }

  return {
    reviewer,
    reviews: map,
    proposals: proposals.map((row) => {
      const proposal: ProposedScenario = {
        tempId: row.tempId,
        targetFile: row.targetFile,
        authorId: row.authorId,
        status: row.status,
        scenario: row.scenario,
      };
      if (row.assignedId !== null) proposal.assignedId = row.assignedId;
      if (row.accepted !== null) proposal.accepted = row.accepted;
      return proposal;
    }),
  };
}

/**
 * The single conflict rule, used by every path that combines two versions of
 * one reviewer's overlay: `.review.json` import, sync pull, and the server's
 * upsert (mirrored there in SQL).
 *
 * Per scenario, the incoming verdict wins iff it is at least as new. Ties go to
 * incoming so re-importing an unchanged file is a no-op rather than a flap.
 * This is the fix for the old importOverlay, which spread incoming over
 * existing unconditionally and let a stale file clobber newer local work.
 *
 * Proposals have no timestamp in the §4.2 contract, so incoming still wins per
 * tempId. Widening ProposedScenario to carry one would be a schema change, and
 * §4.2 is the contract.
 */
export function mergeOverlayInto(
  existing: ReviewOverlay | undefined,
  incoming: ReviewOverlay,
): ReviewOverlay {
  if (!existing) return incoming;

  const reviews: Record<string, ScenarioReview> = { ...existing.reviews };
  for (const [scenarioId, candidate] of Object.entries(incoming.reviews)) {
    const current = reviews[scenarioId];
    if (!current || candidate.reviewedAt.localeCompare(current.reviewedAt) >= 0) {
      reviews[scenarioId] = candidate;
    }
  }

  return {
    reviewer: incoming.reviewer,
    reviews,
    proposals: [
      ...existing.proposals.filter(
        (entry) => !incoming.proposals.some((next) => next.tempId === entry.tempId),
      ),
      ...incoming.proposals,
    ],
  };
}
