// Spec §4.3 — "everything untouched is byte-stable".
//
// The canonical files are hand-maintained and their formatting is not uniform:
// one uses block literals, the other folded scalars, section comments between
// scenarios, quoted flow scalars, and `judge` before `content`. No serializer
// reproduces that from a parsed tree, so export never re-emits the whole file.
// Instead we keep the original text, record where every field lives, and
// splice replacements into just those line ranges.
//
// This module does the recording. `patch.ts` does the splicing.

/** Inclusive line indices into the file's line array. */
export type FieldSpan = {
  key: string;
  start: number;
  end: number;
  /** Column the key starts at, so replacements re-indent correctly. */
  indent: number;
};

export type ScenarioSpan = {
  id: string;
  start: number;
  end: number;
  itemIndent: number;
  keyIndent: number;
  fields: Record<string, FieldSpan>;
};

export type FileSource = {
  text: string;
  lines: string[];
  /** True when the original ended with a newline, so we can restore it. */
  trailingNewline: boolean;
  header: string;
  scenariosLine: number;
  itemIndent: number;
  keyIndent: number;
  items: ScenarioSpan[];
  /** Line index after the last scenario content — where appends go. */
  appendAt: number;
  /** True when the file separates scenarios with a blank line. */
  blankBetweenItems: boolean;
};

const KEY = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/;

function indentOf(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

function isComment(line: string): boolean {
  return line.trim().startsWith('#');
}

/**
 * Scan the raw file into spans. Deliberately line-oriented and forgiving: it
 * never has to understand YAML, only where one key's block stops and the next
 * one starts, which indentation already tells us.
 */
export function scanFile(text: string): FileSource {
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -1) : text;
  const lines = body.split('\n');

  const scenariosLine = lines.findIndex((line) => /^scenarios\s*:/.test(line));
  if (scenariosLine === -1) {
    throw new Error("This file has no `scenarios:` key, so there is nothing to patch.");
  }
  const header = lines.slice(0, scenariosLine).join('\n') + (scenariosLine > 0 ? '\n' : '');

  // The first list item after `scenarios:` sets the indentation for all of them.
  let itemIndent = 2;
  for (let i = scenariosLine + 1; i < lines.length; i += 1) {
    const match = /^( *)- /.exec(lines[i]);
    if (match) {
      itemIndent = match[1].length;
      break;
    }
  }
  const keyIndent = itemIndent + 2;
  const itemPrefix = `${' '.repeat(itemIndent)}- `;

  const starts: number[] = [];
  for (let i = scenariosLine + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith(itemPrefix)) starts.push(i);
  }

  // Last line of the scenarios block that carries content.
  let lastContent = scenariosLine;
  for (let i = lines.length - 1; i > scenariosLine; i -= 1) {
    if (!isBlank(lines[i])) {
      lastContent = i;
      break;
    }
  }

  const items: ScenarioSpan[] = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : lastContent;
    return scanItem(lines, start, end, itemIndent, keyIndent);
  });

  const blankBetweenItems = starts.some((start, index) => {
    if (index === 0) return false;
    return isBlank(lines[start - 1]);
  });

  return {
    text,
    lines,
    trailingNewline,
    header,
    scenariosLine,
    itemIndent,
    keyIndent,
    items,
    appendAt: lastContent + 1,
    blankBetweenItems,
  };
}

function scanItem(
  lines: string[],
  start: number,
  end: number,
  itemIndent: number,
  keyIndent: number,
): ScenarioSpan {
  const fields: Record<string, FieldSpan> = {};

  // The item's first line carries its first key: `  - id: routine-001`.
  const firstMatch = KEY.exec(lines[start].slice(itemIndent + 2));
  const firstKey = firstMatch ? firstMatch[2] : 'id';
  let current: FieldSpan = { key: firstKey, start, end: start, indent: keyIndent };
  let lastNonBlank = start;

  const close = () => {
    current.end = lastNonBlank;
    fields[current.key] = current;
  };

  for (let i = start + 1; i <= end && i < lines.length; i += 1) {
    const line = lines[i];
    if (isBlank(line)) continue;
    const indent = indentOf(line);
    if (indent > keyIndent) {
      lastNonBlank = i;
      continue;
    }
    // At or outside the key column: the current field's block has ended.
    close();
    if (isComment(line)) {
      current = { key: `#comment@${i}`, start: i, end: i, indent };
      lastNonBlank = i;
      continue;
    }
    const match = KEY.exec(line);
    if (match && match[1].length === keyIndent) {
      current = { key: match[2], start: i, end: i, indent: keyIndent };
      lastNonBlank = i;
    } else {
      current = { key: `#unknown@${i}`, start: i, end: i, indent };
      lastNonBlank = i;
    }
  }
  close();

  const idField = fields.id;
  const id = idField ? readInlineValue(lines[idField.start]) : `line-${start + 1}`;

  return { id, start, end, itemIndent, keyIndent, fields };
}

/** `  - id: routine-001` → `routine-001`; strips quotes and trailing comments. */
export function readInlineValue(line: string): string {
  const colon = line.indexOf(':');
  if (colon === -1) return '';
  let value = line.slice(colon + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
    (value.startsWith("'") && value.endsWith("'") && value.length > 1)
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

export function findItem(source: FileSource, id: string): ScenarioSpan | undefined {
  return source.items.find((item) => item.id === id);
}
