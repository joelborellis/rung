// Spec §4.1 — parse both canonical file shapes, validate, and report warnings
// in language a clinician can act on. Unknown categories and tiers are warnings,
// never rejections: the suite is meant to be expandable (§5.4).

import yaml from 'js-yaml';
import {
  isKnownCategory,
  isKnownTier,
  type Context,
  type FileKind,
  type ReviewerNote,
  type Scenario,
  type ScenarioFile,
  type Turn,
} from '../../types/scenario';

export type ImportWarning = {
  scenarioId?: string;
  message: string;
};

export class YamlImportError extends Error {
  constructor(
    message: string,
    readonly line?: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'YamlImportError';
  }
}

export type ParseResult = {
  file: ScenarioFile;
  warnings: ImportWarning[];
};

/**
 * Everything above the `scenarios:` key, verbatim. Re-emitted byte-for-byte
 * on export, which is what AC-5 checks.
 */
export function extractHeader(text: string): string {
  const match = /^scenarios\s*:/m.exec(text);
  if (!match) return '';
  return text.slice(0, match.index);
}

function asString(value: unknown, path: string, warnings: ImportWarning[], id?: string): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) {
    warnings.push({ scenarioId: id, message: `${path} is missing — treated as empty.` });
    return '';
  }
  warnings.push({ scenarioId: id, message: `${path} isn't text — it was read as "${String(value)}".` });
  return String(value);
}

function parseContext(
  raw: unknown,
  warnings: ImportWarning[],
  id: string,
): Context {
  const source = (raw ?? {}) as Record<string, unknown>;
  if (raw === undefined || raw === null) {
    warnings.push({ scenarioId: id, message: 'No context block — the therapist envelope will show as empty.' });
  }
  return {
    assigned_exercise: asString(source.assigned_exercise, 'context.assigned_exercise', warnings, id),
    hierarchy_position: asString(source.hierarchy_position, 'context.hierarchy_position', warnings, id),
    scope_notes: asString(source.scope_notes, 'context.scope_notes', warnings, id),
  };
}

function parseTurns(raw: unknown, warnings: ImportWarning[], id: string): Turn[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    warnings.push({ scenarioId: id, message: 'The conversation is empty.' });
    return [];
  }
  return raw.map((entry, index) => {
    const source = (entry ?? {}) as Record<string, unknown>;
    const role = source.role === 'assistant' ? 'assistant' : 'user';
    if (source.role !== 'user' && source.role !== 'assistant') {
      warnings.push({
        scenarioId: id,
        message: `Turn ${index + 1} has role "${String(source.role)}" — read as Client.`,
      });
    }
    const turn: Turn = {
      role,
      content: asString(source.content, `conversation[${index}].content`, warnings, id),
    };
    if (source.judge === true) turn.judge = true;
    return turn;
  });
}

/** js-yaml resolves bare `2026-08-09` to a Date; keep it a plain date string. */
function asDateString(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? '');
}

function parseReviewerNotes(raw: unknown): ReviewerNote[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw.map((entry) => {
    const source = (entry ?? {}) as Record<string, unknown>;
    const note: ReviewerNote = {
      reviewer: String(source.reviewer ?? ''),
      date: asDateString(source.date),
      concern:
        source.concern === 'rationale' || source.concern === 'realism'
          ? source.concern
          : 'label',
      because: String(source.because ?? ''),
      status:
        source.status === 'accepted' || source.status === 'rejected'
          ? source.status
          : 'contested',
    };
    if (source.proposed_tier !== undefined) note.proposed_tier = String(source.proposed_tier);
    if (typeof source.proposed_result === 'boolean') note.proposed_result = source.proposed_result;
    return note;
  });
}

const INPUT_KEYS = new Set([
  'id', 'category', 'description', 'context', 'conversation',
  'expected_tier', 'rationale', 'reviewed_by', 'reviewer_notes',
]);

const OUTPUT_KEYS = new Set([
  'id', 'category', 'description', 'context', 'conversation',
  'expected_result', 'reason', 'feedback', 'reviewed_by', 'reviewer_notes',
]);

function collectExtra(
  source: Record<string, unknown>,
  known: Set<string>,
): Record<string, unknown> | undefined {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!known.has(key)) extra[key] = value;
  }
  return Object.keys(extra).length > 0 ? extra : undefined;
}

/**
 * Which file shape is this? Explicit `kind` wins; otherwise the presence of
 * `expected_tier` versus `expected_result` decides. Importers drop files onto
 * a slot they choose, so this only has to catch an obvious mix-up.
 */
export function detectKind(text: string): FileKind {
  return /^\s*expected_result\s*:/m.test(text) ? 'output' : 'input';
}

export function parseScenarioFile(text: string, kind: FileKind): ParseResult {
  const warnings: ImportWarning[] = [];
  let doc: unknown;
  try {
    doc = yaml.load(text);
  } catch (error) {
    const mark = (error as { mark?: { line?: number } }).mark;
    const line = typeof mark?.line === 'number' ? mark.line + 1 : undefined;
    throw new YamlImportError(
      line
        ? `This file isn't valid YAML — check line ${line}.`
        : "This file isn't valid YAML.",
      line,
      (error as Error).message,
    );
  }

  const root = doc as { scenarios?: unknown } | null;
  if (!root || typeof root !== 'object' || !Array.isArray(root.scenarios)) {
    throw new YamlImportError(
      "This file doesn't have a `scenarios:` list at the top level. Check that it's one of the two scenario files.",
    );
  }

  const seen = new Set<string>();
  const scenarios: Scenario[] = [];

  root.scenarios.forEach((entry, index) => {
    const source = (entry ?? {}) as Record<string, unknown>;
    const id = typeof source.id === 'string' && source.id.trim() !== ''
      ? source.id
      : `untitled-${index + 1}`;
    if (typeof source.id !== 'string' || source.id.trim() === '') {
      warnings.push({ scenarioId: id, message: `Scenario ${index + 1} has no id — it was given "${id}".` });
    }
    if (seen.has(id)) {
      warnings.push({ scenarioId: id, message: `Duplicate id "${id}" — both copies were kept.` });
    }
    seen.add(id);

    const category = asString(source.category, 'category', warnings, id);
    if (category && !isKnownCategory(kind, category)) {
      warnings.push({ scenarioId: id, message: `New category "${category}" — kept and badged as new.` });
    }

    const conversation = parseTurns(source.conversation, warnings, id);
    const base = {
      id,
      category,
      description: asString(source.description, 'description', warnings, id),
      context: parseContext(source.context, warnings, id),
      conversation,
      reviewed_by:
        typeof source.reviewed_by === 'string' && source.reviewed_by !== ''
          ? source.reviewed_by
          : 'UNREVIEWED',
      reviewer_notes: parseReviewerNotes(source.reviewer_notes),
    };

    if (kind === 'input') {
      const tier = asString(source.expected_tier, 'expected_tier', warnings, id);
      if (tier && !isKnownTier(tier)) {
        warnings.push({ scenarioId: id, message: `Unrecognised tier "${tier}" — kept as written.` });
      }
      if (conversation.length > 0 && conversation[conversation.length - 1].role !== 'user') {
        warnings.push({ scenarioId: id, message: 'This input scenario ends on a Coach turn — input scenarios should end with the client.' });
      }
      scenarios.push({
        ...base,
        kind: 'input',
        expected_tier: tier,
        rationale: asString(source.rationale, 'rationale', warnings, id),
        extra: collectExtra(source, INPUT_KEYS),
      });
    } else {
      const judged = conversation.filter((turn) => turn.judge === true);
      if (judged.length !== 1) {
        warnings.push({
          scenarioId: id,
          message:
            judged.length === 0
              ? 'No turn is marked as the response under review.'
              : `${judged.length} turns are marked as the response under review — there should be exactly one.`,
        });
      }
      if (typeof source.expected_result !== 'boolean') {
        warnings.push({ scenarioId: id, message: 'expected_result isn\'t true or false — read as fail.' });
      }
      scenarios.push({
        ...base,
        kind: 'output',
        expected_result: source.expected_result === true,
        reason: asString(source.reason, 'reason', warnings, id),
        feedback: asString(source.feedback, 'feedback', warnings, id),
        extra: collectExtra(source, OUTPUT_KEYS),
      });
    }
  });

  return {
    file: { kind, header: extractHeader(text), source: text, scenarios },
    warnings,
  };
}
