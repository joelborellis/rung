// Spec §4.2 — the review overlay. Nothing in here ever mutates a Scenario.
// Verdicts are keyed by scenario id and merged only at export time (§3).

import type { FileKind, InputScenario, OutputScenario, TierValue } from './scenario';

export type Verdict<T> =
  | { kind: 'agree' }
  | { kind: 'change'; proposed: T; because: string };

/** The label verdict carries a tier for input files, pass/fail for output. */
export type LabelValue = TierValue | boolean;

export type RationaleVerdict =
  | { kind: 'sound' }
  | { kind: 'flawed'; because: string };

export type RealismVerdict =
  | { kind: 'realistic' }
  | { kind: 'unrealistic'; because: string };

export type ProposedTextEdits = {
  rationale?: string;
  feedback?: string;
  description?: string;
};

export type ScenarioReview = {
  scenarioId: string;
  reviewerId: string;
  reviewedAt: string;
  labelVerdict: Verdict<LabelValue>;
  rationaleVerdict: RationaleVerdict;
  realismVerdict: RealismVerdict;
  hardCase: boolean;
  comment?: string;
  proposedTextEdits?: ProposedTextEdits;
};

export type ProposedScenario = {
  tempId: string;
  targetFile: FileKind;
  authorId: string;
  status: 'draft' | 'submitted';
  scenario: Partial<InputScenario> & Partial<OutputScenario>;
  /** Assigned by the owner in the resolution view before export (§4.3). */
  assignedId?: string;
  accepted?: boolean;
};

export type Reviewer = {
  id: string;
  displayName: string;
  credentials?: string;
};

/** One reviewer's complete overlay — this is the `.review.json` payload. */
export type ReviewOverlay = {
  reviewer: Reviewer;
  reviews: Record<string, ScenarioReview>;
  proposals: ProposedScenario[];
};

export const REVIEW_FILE_VERSION = 1 as const;

export type ReviewFile = {
  format: 'srs.review';
  version: typeof REVIEW_FILE_VERSION;
  exportedAt: string;
  overlay: ReviewOverlay;
};

/**
 * The owner's decisions on contested items (§5.5). Kept outside the per-
 * reviewer overlays because resolution is a property of the canon, not of a
 * reviewer. Keyed `{scenarioId}::{reviewerId}::{concern}`.
 */
export type Resolution = {
  key: string;
  scenarioId: string;
  reviewerId: string;
  concern: 'label' | 'rationale' | 'realism' | 'text';
  decision: 'accept' | 'keep' | 'manual';
  /** Present when decision is 'manual' — the owner's own value. */
  manualValue?: string | boolean;
  resolvedAt: string;
};

export function resolutionKey(
  scenarioId: string,
  reviewerId: string,
  concern: Resolution['concern'],
): string {
  return `${scenarioId}::${reviewerId}::${concern}`;
}

export function isComplete(review: Partial<ScenarioReview> | undefined): boolean {
  return Boolean(review?.labelVerdict && review?.rationaleVerdict && review?.realismVerdict);
}

/** Minimum length for every required "because" field (§4.2). */
export const BECAUSE_MIN = 10;

export function becauseIsValid(text: string | undefined): boolean {
  return (text ?? '').trim().length >= BECAUSE_MIN;
}
