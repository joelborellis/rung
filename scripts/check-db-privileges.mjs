// Static check: only the two things that need DDL may reach for admin.
//
// The app once connected as database admin for weeks without anyone noticing,
// because `DATABASE_URL` happened to hold the admin credential and nothing
// asserted otherwise. `db:verify-role` catches it at runtime, but only if
// someone runs it. This catches it in `npm test`.
//
// The rule: ADMIN_DATABASE_URL is referenced only by an explicit allowlist of
// operator scripts, and never from api/ or src/ — neither the API nor the
// client has any legitimate reason to hold an admin credential.
//
// The allowlist is meant to stay short and to be read when it changes. Adding
// to it is the moment to ask whether the work really needs admin, or whether it
// belongs in a migration.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Operator scripts allowed to hold the admin credential, each with the reason.
 * Every one of these is run by hand by the project owner — none is reachable
 * from the running app.
 */
const ADMIN_ALLOWED = new Set([
  'db/create-database.mjs', // CREATE DATABASE, CREATE ROLE, GRANT
  'db/run-migrations.mjs', // the only thing that runs DDL
  'db/restrict-app-role.mjs', // GRANT/REVOKE CONNECT across databases
  // These two need admin to tell the truth: asked as the app role,
  // information_schema and pg_class are filtered by privilege, so "I can see
  // nothing" and "there is nothing" become indistinguishable — which is the
  // exact question they exist to answer.
  'db/check-blast-radius.mjs',
  'db/verify-app-role.mjs',
  // Proves each credential can still reach what it should after a firewall
  // change, which means connecting as each of them by definition.
  'db/check-connectivity.mjs',
  // The generic loader. It names the variable in a help string but never reads
  // the value — callers pass the name in, and this check catches those at the
  // call site, which is where it matters.
  'db/env.mjs',
]);

const SEARCH_DIRS = ['api', 'db', 'src', 'shared', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'artifacts', 'backups']);

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(full);
  }
  return out;
}

const files = SEARCH_DIRS.flatMap((dir) => walk(join(ROOT, dir)));
const violations = [];

for (const file of files) {
  const rel = relative(ROOT, file).replaceAll('\\', '/');
  // This file names the variable in its own rules; don't flag itself.
  if (rel === 'scripts/check-db-privileges.mjs') continue;

  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.includes('ADMIN_DATABASE_URL')) return;
    // A comment explaining the split is fine; reading the value is not.
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    if (rel.startsWith('api/') || rel.startsWith('src/') || rel.startsWith('shared/')) {
      violations.push({
        rel,
        line: i + 1,
        why: 'the app must never hold an admin credential',
        text: trimmed,
      });
    } else if (!ADMIN_ALLOWED.has(rel)) {
      violations.push({
        rel,
        line: i + 1,
        why: 'not on the admin allowlist in scripts/check-db-privileges.mjs',
        text: trimmed,
      });
    }
  });
}

if (violations.length === 0) {
  console.log(
    'DB privilege split OK: the app never holds an admin credential; only allowlisted operator scripts do.',
  );
  process.exit(0);
}

console.error('\nDatabase privilege split violated:\n');
for (const v of violations) {
  console.error(`  ${v.rel}:${v.line}  ${v.why}`);
  console.error(`    ${v.text}\n`);
}
console.error('DATABASE_URL is the least-privilege app role and is what everything should use.');
console.error('If you genuinely need DDL, it belongs in a migration. If this is an operator');
console.error('script that really needs admin, add it to ADMIN_ALLOWED with the reason.\n');
process.exit(1);
