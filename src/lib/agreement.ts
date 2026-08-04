// Spec §6 — the agreement report. Simple percentages and, more importantly,
// the list of scenarios reviewers actually split on. No kappa in v1.

import type { ReviewOverlay } from '../types/review';
import type { Scenario, ScenarioFile } from '../types/scenario';
import { currentLabel } from './merge';

export type ReviewerLabel = {
  reviewerId: string;
  displayName: string;
  label: string;
  agreed: boolean;
  because?: string;
};

export type Disagreement = {
  scenario: Scenario;
  canonLabel: string;
  labels: ReviewerLabel[];
};

export type AgreementReport = {
  reviewedCount: number;
  multiReviewedCount: number;
  agreedCount: number;
  percent: number | null;
  byCategory: Array<{ category: string; total: number; agreed: number; percent: number | null }>;
  disagreements: Disagreement[];
};

export function labelsFor(scenario: Scenario, overlays: ReviewOverlay[]): ReviewerLabel[] {
  const canon = currentLabel(scenario);
  return overlays
    .filter((overlay) => overlay.reviews[scenario.id])
    .map((overlay) => {
      const verdict = overlay.reviews[scenario.id].labelVerdict;
      const entry: ReviewerLabel = {
        reviewerId: overlay.reviewer.id,
        displayName: overlay.reviewer.displayName,
        label: verdict.kind === 'agree' ? canon : String(verdict.proposed),
        agreed: verdict.kind === 'agree',
      };
      if (verdict.kind === 'change') entry.because = verdict.because;
      return entry;
    });
}

export function buildAgreementReport(
  file: ScenarioFile,
  overlays: ReviewOverlay[],
): AgreementReport {
  const perCategory = new Map<string, { total: number; agreed: number }>();
  const disagreements: Disagreement[] = [];
  let reviewedCount = 0;
  let multiReviewedCount = 0;
  let agreedCount = 0;

  for (const scenario of file.scenarios) {
    const labels = labelsFor(scenario, overlays);
    if (labels.length > 0) reviewedCount += 1;
    if (labels.length < 2) continue;

    multiReviewedCount += 1;
    const unanimous = new Set(labels.map((entry) => entry.label)).size === 1;
    if (unanimous) agreedCount += 1;
    else {
      disagreements.push({ scenario, canonLabel: currentLabel(scenario), labels });
    }

    const key = String(scenario.category);
    const bucket = perCategory.get(key) ?? { total: 0, agreed: 0 };
    bucket.total += 1;
    if (unanimous) bucket.agreed += 1;
    perCategory.set(key, bucket);
  }

  return {
    reviewedCount,
    multiReviewedCount,
    agreedCount,
    percent: multiReviewedCount === 0 ? null : Math.round((agreedCount / multiReviewedCount) * 100),
    byCategory: [...perCategory.entries()]
      .map(([category, bucket]) => ({
        category,
        total: bucket.total,
        agreed: bucket.agreed,
        percent: bucket.total === 0 ? null : Math.round((bucket.agreed / bucket.total) * 100),
      }))
      .sort((a, b) => a.category.localeCompare(b.category)),
    disagreements,
  };
}

/**
 * The inline strip on the stage (§6): "JD proposed pause_and_route;
 * MK agreed with support_and_continue."
 */
export function disagreementSummary(labels: ReviewerLabel[], initialsOf: (name: string) => string): string {
  return labels
    .map((entry) =>
      entry.agreed
        ? `${initialsOf(entry.displayName)} agreed with ${entry.label}`
        : `${initialsOf(entry.displayName)} proposed ${entry.label}`,
    )
    .join('; ');
}
