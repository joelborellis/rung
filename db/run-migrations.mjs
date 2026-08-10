// Apply db/migrations/*.sql in filename order, once each, each in its own
// transaction. Run with `npm run db:migrate`.
//
// No ORM and no migration framework: the schema is small, the jsonb columns
// are typed by shared/review.ts, and a second schema definition is a second
// thing that can drift from the TypeScript contract.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import pg from 'pg';
import { requireUrl } from './env.mjs';

const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), 'migrations');

const LEDGER = `
  create table if not exists schema_migrations (
    filename   text primary key,
    sha256     text not null,
    applied_at timestamptz not null default now()
  )
`;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function main() {
  // Migrations are the one thing that needs DDL, so they are the one thing
  // that connects as admin. Everything else — the API included — uses
  // DATABASE_URL, which is the least-privilege rung_app role.
  const client = new pg.Client({ connectionString: requireUrl('ADMIN_DATABASE_URL') });
  await client.connect();

  try {
    await client.query(LEDGER);
    const applied = new Map(
      (await client.query('select filename, sha256 from schema_migrations')).rows.map((r) => [
        r.filename,
        r.sha256,
      ]),
    );

    const files = readdirSync(MIGRATIONS)
      .filter((name) => name.endsWith('.sql'))
      .sort();

    let ran = 0;
    for (const filename of files) {
      const sql = readFileSync(join(MIGRATIONS, filename), 'utf8');
      const digest = sha256(sql);
      const seen = applied.get(filename);

      if (seen === digest) {
        console.log(`  = ${filename} (already applied)`);
        continue;
      }
      if (seen && seen !== digest) {
        // Editing an applied migration means two databases silently disagree.
        throw new Error(
          `${filename} was already applied but its contents changed.\n` +
            `Add a new migration instead of editing this one.`,
        );
      }

      await client.query('begin');
      try {
        await client.query(sql);
        await client.query(
          'insert into schema_migrations (filename, sha256) values ($1, $2)',
          [filename, digest],
        );
        await client.query('commit');
        console.log(`  + ${filename}`);
        ran += 1;
      } catch (error) {
        await client.query('rollback');
        throw new Error(`${filename} failed and was rolled back:\n${error.message}`);
      }
    }

    console.log(ran === 0 ? '\nNothing to do — schema is up to date.' : `\nApplied ${ran}.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\n${error.message}`);
  process.exit(1);
});
