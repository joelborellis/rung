// Reviewer identity and the `reviewed_by` stamp grammar (§4.3).

import type { Reviewer, ScenarioReview } from '../types/review';
import type { FileKind } from '../types/scenario';

export function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'reviewer'
  );
}

/** "Jane Doe" → "JD". Stamps and the disagreement strip both use initials. */
export function initials(displayName: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  return parts
    .slice(0, 3)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

/** "JD (LPC)" or just "JD" when no credentials were given. */
export function reviewerMark(reviewer: Reviewer): string {
  const mark = initials(reviewer.displayName);
  return reviewer.credentials?.trim() ? `${mark} (${reviewer.credentials.trim()})` : mark;
}

export function isoDate(iso: string): string {
  return iso.slice(0, 10);
}

export function todayIso(): string {
  return new Date().toISOString();
}

/** The label half of a stamp: `agree`, `tier→pause_and_route`, `result→fail`. */
export function labelStampFragment(review: ScenarioReview, kind: FileKind): string {
  if (review.labelVerdict.kind === 'agree') return 'agree';
  const proposed = review.labelVerdict.proposed;
  if (kind === 'input') return `tier→${String(proposed)}`;
  return `result→${proposed === true ? 'pass' : 'fail'}`;
}

/**
 * One stamp: `JD (LPC) 2026-08-09: agree`. The hard-case flag is carried here
 * too — it is review data the YAML would otherwise lose, and it does not
 * change the meaning of the label fragment ahead of it.
 */
export function buildStamp(reviewer: Reviewer, review: ScenarioReview, kind: FileKind): string {
  const parts = [labelStampFragment(review, kind)];
  if (review.hardCase) parts.push('hard case');
  return `${reviewerMark(reviewer)} ${isoDate(review.reviewedAt)}: ${parts.join(', ')}`;
}

/** UNREVIEWED is replaced; anything else is appended to, semicolon-separated. */
export function appendStamp(existing: string, stamp: string): string {
  const current = existing.trim();
  if (current === '' || current === 'UNREVIEWED') return stamp;
  if (current.split(';').some((part) => part.trim() === stamp)) return current;
  return `${current}; ${stamp}`;
}

export function authoredStamp(reviewer: Reviewer, iso: string): string {
  return `AUTHORED: ${reviewerMark(reviewer)} ${isoDate(iso)}`;
}
