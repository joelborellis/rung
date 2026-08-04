// Spec §3 / §4.3 — the custom serializer.
//
// js-yaml's dump() cannot promise byte-stability: it re-picks scalar styles,
// re-wraps folded text, and orders keys by insertion. AC-5 and AC-6 need a
// diff a human reads as surgical, so emission is done here instead, with one
// deterministic style rule per field. Field order is §4.1's, hard-coded.
//
// The canonical files in /data are authored in exactly this shape, which is
// what makes an untouched scenario round-trip byte-for-byte.

import type {
  Context,
  ReviewerNote,
  Scenario,
  ScenarioFile,
  Turn,
} from '../../types/scenario';

const INDENT = '  ';

/** Scalars safe to emit bare. Anything else gets double-quoted. */
const PLAIN_SAFE = /^[A-Za-z0-9][A-Za-z0-9_\-./]*$/;

/** Words YAML 1.1 would read as something other than a string. */
const RESERVED = new Set([
  'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE',
  'on', 'On', 'ON', 'off', 'Off', 'OFF',
  'null', 'Null', 'NULL', '~',
]);

function pad(level: number): string {
  return INDENT.repeat(level);
}

/**
 * js-yaml's default schema resolves bare `2026-08-09` to a Date, so anything
 * date-shaped has to be quoted or it stops being a string on re-import.
 */
const DATE_LIKE = /^\d{4}-\d{1,2}(-\d{1,2})?/;

/** A short identifier-ish value: `routine-001`, `no_issue`, `UNREVIEWED`. */
export function token(value: string): string {
  if (
    value.length > 0 &&
    value.length <= 120 &&
    PLAIN_SAFE.test(value) &&
    !RESERVED.has(value) &&
    !DATE_LIKE.test(value) &&
    !/^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$/.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

/**
 * Can this string survive a block literal? Trailing whitespace on a line and
 * a leading space on the first line both change meaning or require an
 * indentation indicator, so those fall back to a quoted flow scalar.
 */
function blockSafe(value: string): boolean {
  if (value === '') return false;
  if (value.includes('\r')) return false;
  if (/^[ \t]/.test(value)) return false;
  // Control characters other than \n cannot appear in a block scalar.
  if (new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]').test(value)) {
    return false;
  }
  return !value.split('\n').some((line) => /[ \t]$/.test(line));
}

/**
 * Prose fields — description, rationale, reason, feedback, turn content, the
 * three context fields. Always a block literal when the text allows it, so
 * that internal newlines are preserved exactly and re-emission is identical.
 */
export function blockScalar(value: string, level: number): string[] {
  if (!blockSafe(value)) {
    return [JSON.stringify(value)];
  }
  let chomp = '-';
  let body = value;
  if (value.endsWith('\n\n')) {
    chomp = '+';
  } else if (value.endsWith('\n')) {
    chomp = '';
    body = value.slice(0, -1);
  }
  const lines = body.split('\n').map((line) => (line === '' ? '' : pad(level) + line));
  return [`|${chomp}`, ...lines];
}

/** `key: |-` followed by the indented block, or `key: "…"` on one line. */
function proseField(key: string, value: string, level: number): string[] {
  const [head, ...rest] = blockScalar(value, level + 1);
  return [`${pad(level)}${key}: ${head}`, ...rest];
}

function tokenField(key: string, value: string, level: number): string {
  return `${pad(level)}${key}: ${token(value)}`;
}

function boolField(key: string, value: boolean, level: number): string {
  return `${pad(level)}${key}: ${value ? 'true' : 'false'}`;
}

function emitContext(context: Context, level: number): string[] {
  return [
    `${pad(level)}context:`,
    ...proseField('assigned_exercise', context.assigned_exercise, level + 1),
    ...proseField('hierarchy_position', context.hierarchy_position, level + 1),
    ...proseField('scope_notes', context.scope_notes, level + 1),
  ];
}

function emitTurn(turn: Turn, level: number): string[] {
  // The `- ` marker sits one level out; keys align to `level`.
  const first = `${pad(level - 1)}- role: ${token(turn.role)}`;
  const lines = [first, ...proseField('content', turn.content, level)];
  if (turn.judge === true) {
    lines.push(boolField('judge', true, level));
  }
  return lines;
}

export function emitReviewerNotes(notes: ReviewerNote[], level: number): string[] {
  const lines: string[] = [`${pad(level)}reviewer_notes:`];
  for (const note of notes) {
    lines.push(`${pad(level + 1)}- reviewer: ${token(note.reviewer)}`);
    lines.push(tokenField('date', note.date, level + 2));
    lines.push(tokenField('concern', note.concern, level + 2));
    if (note.proposed_tier !== undefined) {
      lines.push(tokenField('proposed_tier', note.proposed_tier, level + 2));
    }
    if (note.proposed_result !== undefined) {
      lines.push(boolField('proposed_result', note.proposed_result, level + 2));
    }
    lines.push(...proseField('because', note.because, level + 2));
    lines.push(tokenField('status', note.status, level + 2));
  }
  return lines;
}

/**
 * Unrecognised keys, re-emitted last so nothing an upstream author added is
 * silently dropped. Values go through js-yaml-compatible JSON, which is a
 * strict subset of YAML flow style.
 */
function emitExtra(extra: Record<string, unknown>, level: number): string[] {
  return Object.entries(extra).map(
    ([key, value]) => `${pad(level)}${key}: ${JSON.stringify(value)}`,
  );
}

/**
 * Emit a scenario from the model. Used for scenarios that have no source text
 * to preserve — newly authored ones being appended, and the export preview.
 */
export function emitScenario(scenario: Scenario, itemIndent = 2): string[] {
  const base = itemIndent / 2;
  const lines: string[] = [`${pad(base)}- id: ${token(scenario.id)}`];
  const L = base + 1;
  lines.push(tokenField('category', scenario.category, L));
  lines.push(...proseField('description', scenario.description, L));
  lines.push(...emitContext(scenario.context, L));
  lines.push(`${pad(L)}conversation:`);
  for (const turn of scenario.conversation) {
    lines.push(...emitTurn(turn, L + 2));
  }
  if (scenario.kind === 'input') {
    lines.push(tokenField('expected_tier', scenario.expected_tier, L));
    lines.push(...proseField('rationale', scenario.rationale, L));
  } else {
    lines.push(boolField('expected_result', scenario.expected_result, L));
    lines.push(...proseField('reason', scenario.reason, L));
    lines.push(...proseField('feedback', scenario.feedback, L));
  }
  lines.push(tokenField('reviewed_by', scenario.reviewed_by, L));
  if (scenario.reviewer_notes && scenario.reviewer_notes.length > 0) {
    lines.push(...emitReviewerNotes(scenario.reviewer_notes, L));
  }
  if (scenario.extra && Object.keys(scenario.extra).length > 0) {
    lines.push(...emitExtra(scenario.extra, L));
  }
  return lines;
}

/** The whole file: verbatim header + `scenarios:` + every scenario. */
export function emitFile(file: ScenarioFile): string {
  const body = file.scenarios.flatMap((scenario) => emitScenario(scenario));
  return `${file.header}scenarios:\n${body.join('\n')}\n`;
}
