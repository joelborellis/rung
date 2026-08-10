// The non-negotiable from spec §3, made mechanical.
//
// "Merging happens only at export time" holds because the server has no code
// path that could merge. That is only true as long as api/ cannot reach the
// merge, YAML, agreement, or stamp code. This check is what keeps a future
// well-meaning "just import mergeFile on the server, it's right there" from
// quietly dissolving the architecture.
//
// api/ may import from shared/ — that is the contract both sides speak.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = join(ROOT, 'api');

/** Paths api/ must never reach into, and why. */
const FORBIDDEN = [
  { pattern: /(^|['"\s(])(\.\.\/)+src\/lib\//, why: 'src/lib — merge, export, YAML, stamps' },
  { pattern: /(^|['"\s(])(\.\.\/)+src\/store\//, why: 'src/store — client state and localStorage' },
  { pattern: /(^|['"\s(])(\.\.\/)+src\/components\//, why: 'src/components — React' },
  { pattern: /from\s+['"]react['"]/, why: 'react' },
  { pattern: /from\s+['"]js-yaml['"]/, why: 'js-yaml — the server never parses YAML' },
  { pattern: /from\s+['"]zustand['"]/, why: 'zustand' },
];

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(API)) {
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    // Only import/require lines; a comment naming src/lib is fine and this
    // file's own rules table would otherwise flag itself.
    if (!/^\s*(import|export)\s|require\s*\(/.test(line)) return;
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(line)) {
        violations.push({ file: relative(ROOT, file), line: i + 1, why, text: line.trim() });
      }
    }
  });
}

if (violations.length === 0) {
  console.log('Import boundary OK: api/ does not reach into the client or the merge path.');
  process.exit(0);
}

console.error('\nImport boundary violated (spec §3 — the server must not merge):\n');
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  imports ${v.why}`);
  console.error(`    ${v.text}\n`);
}
console.error('api/ may import from shared/ only. Move what you need there, or');
console.error('reconsider whether the server should be doing this at all.\n');
process.exit(1);
