// A portable backup, without needing pg_dump installed.
//
// Azure Postgres Flexible Server has point-in-time restore, which is the real
// safety net — but PITR restores a whole server and needs the Azure portal. A
// plain JSON dump you can read, grep, and re-import is what you actually want
// when one counselor's verdicts went missing and the batch is still running.
//
//   node db/backup.mjs                    → backups/rung-<timestamp>.json
//   node db/backup.mjs --out somewhere.json
//
// The scenario YAML is included, so a backup is self-contained: it carries the
// canon those verdicts were judged against, not just the verdicts.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { requireUrl } from './env.mjs';

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = resolve(arg('out') ?? `backups/rung-${stamp}.json`);

const TABLES = [
  'people',
  'rounds',
  'datasets',
  'round_participants',
  'reviews',
  'proposals',
  'resolutions',
  'exports',
  'review_history',
  'schema_migrations',
];

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();

const dump = { takenAt: new Date().toISOString(), tables: {} };
let rows = 0;

try {
  for (const table of TABLES) {
    try {
      const result = await client.query(`select * from ${table}`);
      dump.tables[table] = result.rows;
      rows += result.rowCount;
      console.log(`  ${String(result.rowCount).padStart(6)}  ${table}`);
    } catch (error) {
      // A table added by a later migration may not exist in an older database.
      console.log(`  ${'—'.padStart(6)}  ${table} (${error.message.split('\n')[0]})`);
    }
  }

  // Invite hashes are credentials-adjacent: a backup should not be the thing
  // that leaks them, and they are useless without the raw token anyway.
  const invites = await client.query(
    `select id, person_id, token_prefix, created_at, created_by,
            expires_at, revoked_at, last_used_at, use_count
       from invites`,
  );
  dump.tables.invites = invites.rows;
  dump.note = 'invites.token_hash is deliberately omitted — reissue links rather than restoring them.';
  console.log(`  ${String(invites.rowCount).padStart(6)}  invites (token_hash omitted)`);
  rows += invites.rowCount;
} finally {
  await client.end();
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(dump, null, 2)}\n`, 'utf8');

console.log(`\n${rows} rows → ${out}`);
