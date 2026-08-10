// Database rows <-> the ReviewOverlay contract.
//
// This module is the entire surface where the database touches review data.
// It converts snake_case Postgres rows into the camelCase row types from
// shared/overlay.ts, which then reassemble into a ReviewOverlay identical to
// one parsed out of a .review.json.
//
// What this file must never do, and what the CI import check enforces:
// import from src/lib. No merging, no YAML, no stamps, no agreement maths.
// The server moves overlays; the browser merges them (spec §3).

import type {
  ProposedScenario,
  ProposedTextEdits,
  RationaleVerdict,
  RealismVerdict,
  Resolution,
  Reviewer,
  ReviewOverlay,
} from '../../shared/review';
import { resolutionKey } from '../../shared/review';
import type { LabelValue, Verdict } from '../../shared/review';
import type { ProposalRow, ReviewRow } from '../../shared/overlay';
import { rowsToOverlay } from '../../shared/overlay';
import type { FileKind } from '../../shared/scenario';

// ---------------------------------------------------------------------------
// Row shapes exactly as `pg` hands them back. jsonb columns arrive already
// parsed; text and timestamptz arrive as string and Date respectively.
// ---------------------------------------------------------------------------

export type DbReviewRow = {
  round_id: string;
  person_id: string;
  scenario_id: string;
  file_kind: FileKind;
  reviewed_at_iso: string;
  label_verdict: Verdict<LabelValue>;
  rationale_verdict: RationaleVerdict;
  realism_verdict: RealismVerdict;
  hard_case: boolean;
  comment: string | null;
  proposed_text_edits: ProposedTextEdits | null;
};

export type DbProposalRow = {
  round_id: string;
  author_id: string;
  temp_id: string;
  target_file: FileKind;
  status: 'draft' | 'submitted';
  scenario: ProposedScenario['scenario'];
  assigned_id: string | null;
  accepted: boolean | null;
};

export type DbPersonRow = {
  id: string;
  email: string;
  display_name: string;
  credentials: string | null;
  role: 'reviewer' | 'owner';
};

export type DbResolutionRow = {
  scenario_id: string;
  person_id: string;
  concern: Resolution['concern'];
  decision: Resolution['decision'];
  manual_value: string | boolean | null;
  resolved_at_iso: string;
};

// ---------------------------------------------------------------------------
// Row -> contract
// ---------------------------------------------------------------------------

export function toReviewRow(row: DbReviewRow): ReviewRow {
  return {
    roundId: row.round_id,
    personId: row.person_id,
    scenarioId: row.scenario_id,
    fileKind: row.file_kind,
    // Verbatim, never re-derived from the timestamptz column: merge.ts sorts
    // on this string and stamps.ts slices its first 10 chars into the YAML.
    reviewedAtIso: row.reviewed_at_iso,
    labelVerdict: row.label_verdict,
    rationaleVerdict: row.rationale_verdict,
    realismVerdict: row.realism_verdict,
    hardCase: row.hard_case,
    comment: row.comment,
    proposedTextEdits: row.proposed_text_edits,
  };
}

export function toProposalRow(row: DbProposalRow): ProposalRow {
  return {
    roundId: row.round_id,
    authorId: row.author_id,
    tempId: row.temp_id,
    targetFile: row.target_file,
    status: row.status,
    scenario: row.scenario,
    assignedId: row.assigned_id,
    accepted: row.accepted,
  };
}

/** The `Reviewer` the client sees. Email is identity, and stays server-side. */
export function toReviewer(row: DbPersonRow): Reviewer {
  const reviewer: Reviewer = { id: row.id, displayName: row.display_name };
  if (row.credentials !== null) reviewer.credentials = row.credentials;
  return reviewer;
}

export function toResolution(row: DbResolutionRow): Resolution {
  const resolution: Resolution = {
    key: resolutionKey(row.scenario_id, row.person_id, row.concern),
    scenarioId: row.scenario_id,
    reviewerId: row.person_id,
    concern: row.concern,
    decision: row.decision,
    resolvedAt: row.resolved_at_iso,
  };
  // jsonb, so a boolean stays a boolean — merge.ts compares it with === true.
  if (row.manual_value !== null) resolution.manualValue = row.manual_value;
  return resolution;
}

/** Assemble one person's complete overlay from their rows. */
export function toOverlay(
  person: DbPersonRow,
  reviews: DbReviewRow[],
  proposals: DbProposalRow[],
): ReviewOverlay {
  return rowsToOverlay(toReviewer(person), {
    reviews: reviews.map(toReviewRow),
    proposals: proposals.map(toProposalRow),
  });
}

// ---------------------------------------------------------------------------
// Contract -> parameters
//
// Written as ordered arrays matching the SQL below rather than an object
// mapper, so the column list and the values can be read together and cannot
// drift apart silently.
// ---------------------------------------------------------------------------

export const INSERT_REVIEW_SQL = `
  insert into reviews (
    round_id, person_id, scenario_id, file_kind,
    reviewed_at_iso, reviewed_at,
    label_verdict, rationale_verdict, realism_verdict,
    hard_case, comment, proposed_text_edits, dataset_id, device_id
  ) values (
    $1, $2, $3, $4,
    -- Both casts are explicit: the same parameter feeds a text column and a
    -- timestamptz one, and without them Postgres deduces conflicting types
    -- for $5 and rejects the statement outright.
    $5::text, $5::timestamptz,
    $6::jsonb, $7::jsonb, $8::jsonb,
    $9, $10, $11::jsonb, $12, $13
  )
  on conflict (round_id, person_id, scenario_id) do update set
    file_kind           = excluded.file_kind,
    reviewed_at_iso     = excluded.reviewed_at_iso,
    reviewed_at         = excluded.reviewed_at,
    label_verdict       = excluded.label_verdict,
    rationale_verdict   = excluded.rationale_verdict,
    realism_verdict     = excluded.realism_verdict,
    hard_case           = excluded.hard_case,
    comment             = excluded.comment,
    proposed_text_edits = excluded.proposed_text_edits,
    dataset_id          = excluded.dataset_id,
    device_id           = excluded.device_id,
    updated_at          = now()
  -- The conflict policy, in SQL, mirroring mergeOverlayInto in
  -- shared/overlay.ts: a write only lands if it is at least as new as what is
  -- already stored. This is what stops a stale second device from reverting
  -- newer work. Ties update so a replayed request is idempotent, not a no-op
  -- that looks like a failure.
  where excluded.reviewed_at_iso >= reviews.reviewed_at_iso
  returning scenario_id, updated_at`;

export function insertReviewParams(
  row: ReviewRow,
  extra: { datasetId?: string | null; deviceId?: string | null } = {},
): unknown[] {
  return [
    row.roundId,
    row.personId,
    row.scenarioId,
    row.fileKind,
    row.reviewedAtIso,
    JSON.stringify(row.labelVerdict),
    JSON.stringify(row.rationaleVerdict),
    JSON.stringify(row.realismVerdict),
    row.hardCase,
    row.comment,
    row.proposedTextEdits === null ? null : JSON.stringify(row.proposedTextEdits),
    extra.datasetId ?? null,
    extra.deviceId ?? null,
  ];
}

export const UPSERT_PROPOSAL_SQL = `
  insert into proposals (
    round_id, author_id, temp_id, target_file, status, scenario
  ) values ($1, $2, $3, $4, $5, $6::jsonb)
  on conflict (round_id, author_id, temp_id) do update set
    target_file = excluded.target_file,
    status      = excluded.status,
    scenario    = excluded.scenario,
    updated_at  = now()
  returning temp_id`;

/**
 * Note the omission: assigned_id and accepted are NOT written here. They are
 * owner-only fields, set through the resolution view, and a reviewer's sync
 * must not be able to clear the owner's id assignment by re-saving a draft.
 */
export function upsertProposalParams(row: ProposalRow): unknown[] {
  return [
    row.roundId,
    row.authorId,
    row.tempId,
    row.targetFile,
    row.status,
    JSON.stringify(row.scenario),
  ];
}
