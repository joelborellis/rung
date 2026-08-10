// Shape validation for anything a client sends.
//
// The database has CHECK constraints for the same unions, but a constraint
// violation surfaces as a 500 with a Postgres message. Validating here turns
// the same mistake into a 400 that names the field, and keeps the error copy
// in the app's voice.
//
// Nothing here trusts the client for identity: reviewerId and authorId are
// taken from the session and overwritten, never read from the body.

import { badRequest } from './http';
import { BECAUSE_MIN } from '../../shared/review';
import type {
  LabelValue,
  ProposedScenario,
  ProposedTextEdits,
  RationaleVerdict,
  RealismVerdict,
  Resolution,
  ScenarioReview,
  Verdict,
} from '../../shared/review';
import type { FileKind } from '../../shared/scenario';

function obj(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('BAD_FIELD', `"${field}" must be an object.`);
  }
  return value as Record<string, unknown>;
}

function str(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest('BAD_FIELD', `"${field}" is required.`);
  }
  return value;
}

function because(value: unknown, field: string): string {
  const text = str(value, field);
  // §4.2: a change verdict must say why, and "no" is not a reason.
  if (text.trim().length < BECAUSE_MIN) {
    throw badRequest('BAD_FIELD', `"${field}" needs at least ${BECAUSE_MIN} characters.`);
  }
  return text;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = str(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw badRequest('BAD_FIELD', `"${field}" must be an ISO timestamp.`);
  }
  // A clock a long way ahead would win every last-write-wins comparison
  // forever. Reject rather than silently let one device dominate.
  if (Date.parse(text) - Date.now() > 24 * 60 * 60 * 1000) {
    throw badRequest('CLOCK_SKEW', 'Your device clock looks wrong — it is more than a day ahead.');
  }
  return text;
}

function labelVerdict(value: unknown): Verdict<LabelValue> {
  const raw = obj(value, 'labelVerdict');
  if (raw.kind === 'agree') return { kind: 'agree' };
  if (raw.kind === 'change') {
    const proposed = raw.proposed;
    // A tier for input files, pass/fail for output. Both arrive here.
    if (typeof proposed !== 'string' && typeof proposed !== 'boolean') {
      throw badRequest('BAD_FIELD', '"labelVerdict.proposed" must be a tier or true/false.');
    }
    return { kind: 'change', proposed, because: because(raw.because, 'labelVerdict.because') };
  }
  throw badRequest('BAD_FIELD', '"labelVerdict.kind" must be "agree" or "change".');
}

function rationaleVerdict(value: unknown): RationaleVerdict {
  const raw = obj(value, 'rationaleVerdict');
  if (raw.kind === 'sound') return { kind: 'sound' };
  if (raw.kind === 'flawed') {
    return { kind: 'flawed', because: because(raw.because, 'rationaleVerdict.because') };
  }
  throw badRequest('BAD_FIELD', '"rationaleVerdict.kind" must be "sound" or "flawed".');
}

function realismVerdict(value: unknown): RealismVerdict {
  const raw = obj(value, 'realismVerdict');
  if (raw.kind === 'realistic') return { kind: 'realistic' };
  if (raw.kind === 'unrealistic') {
    return { kind: 'unrealistic', because: because(raw.because, 'realismVerdict.because') };
  }
  throw badRequest('BAD_FIELD', '"realismVerdict.kind" must be "realistic" or "unrealistic".');
}

function textEdits(value: unknown): ProposedTextEdits | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = obj(value, 'proposedTextEdits');
  const out: ProposedTextEdits = {};
  for (const key of ['rationale', 'feedback', 'description'] as const) {
    const entry = raw[key];
    if (entry === undefined || entry === null) continue;
    if (typeof entry !== 'string') {
      throw badRequest('BAD_FIELD', `"proposedTextEdits.${key}" must be text.`);
    }
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * A ScenarioReview from the wire, with identity forced to the session's.
 * A client that sends someone else's reviewerId gets it silently replaced,
 * which is the correct outcome: it is not their field to set.
 */
export function parseScenarioReview(value: unknown, reviewerId: string): ScenarioReview {
  const raw = obj(value, 'review');
  const review: ScenarioReview = {
    scenarioId: str(raw.scenarioId, 'scenarioId'),
    reviewerId,
    reviewedAt: isoTimestamp(raw.reviewedAt, 'reviewedAt'),
    labelVerdict: labelVerdict(raw.labelVerdict),
    rationaleVerdict: rationaleVerdict(raw.rationaleVerdict),
    realismVerdict: realismVerdict(raw.realismVerdict),
    hardCase: raw.hardCase === true,
  };
  if (typeof raw.comment === 'string' && raw.comment !== '') review.comment = raw.comment;
  const edits = textEdits(raw.proposedTextEdits);
  if (edits) review.proposedTextEdits = edits;
  return review;
}

export function parseProposal(
  value: unknown,
  authorId: string,
  { allowOwnerFields }: { allowOwnerFields: boolean },
): ProposedScenario {
  const raw = obj(value, 'proposal');
  const targetFile = raw.targetFile;
  if (targetFile !== 'input' && targetFile !== 'output') {
    throw badRequest('BAD_FIELD', '"targetFile" must be "input" or "output".');
  }
  const status = raw.status;
  if (status !== 'draft' && status !== 'submitted') {
    throw badRequest('BAD_FIELD', '"status" must be "draft" or "submitted".');
  }

  const proposal: ProposedScenario = {
    tempId: str(raw.tempId, 'tempId'),
    targetFile: targetFile as FileKind,
    authorId,
    status,
    scenario: obj(raw.scenario, 'scenario') as ProposedScenario['scenario'],
  };

  // assignedId and accepted are the owner's decisions in the resolution view.
  // A reviewer re-saving a draft must not be able to clear them.
  if (raw.assignedId !== undefined || raw.accepted !== undefined) {
    if (!allowOwnerFields) {
      throw badRequest(
        'OWNER_FIELD',
        'Only the project owner can assign an id or accept a scenario.',
      );
    }
    if (typeof raw.assignedId === 'string') proposal.assignedId = raw.assignedId;
    if (typeof raw.accepted === 'boolean') proposal.accepted = raw.accepted;
  }

  return proposal;
}

const CONCERNS = ['label', 'rationale', 'realism', 'text'] as const;
const DECISIONS = ['accept', 'keep', 'manual'] as const;

export function parseResolution(value: unknown): Omit<Resolution, 'key'> {
  const raw = obj(value, 'resolution');
  const concern = raw.concern as Resolution['concern'];
  if (!CONCERNS.includes(concern)) {
    throw badRequest('BAD_FIELD', `"concern" must be one of ${CONCERNS.join(', ')}.`);
  }
  const decision = raw.decision as Resolution['decision'];
  if (!DECISIONS.includes(decision)) {
    throw badRequest('BAD_FIELD', `"decision" must be one of ${DECISIONS.join(', ')}.`);
  }

  const resolution: Omit<Resolution, 'key'> = {
    scenarioId: str(raw.scenarioId, 'scenarioId'),
    reviewerId: str(raw.reviewerId, 'reviewerId'),
    concern,
    decision,
    resolvedAt: isoTimestamp(raw.resolvedAt, 'resolvedAt'),
  };

  if (decision === 'manual') {
    // Must stay a boolean when it is one: merge.ts compares with === true.
    if (typeof raw.manualValue !== 'string' && typeof raw.manualValue !== 'boolean') {
      throw badRequest('BAD_FIELD', 'A manual resolution needs a "manualValue".');
    }
    resolution.manualValue = raw.manualValue;
  }

  return resolution;
}

export function parseStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw badRequest('BAD_FIELD', `"${field}" must be an array of ids.`);
  }
  return value as string[];
}
