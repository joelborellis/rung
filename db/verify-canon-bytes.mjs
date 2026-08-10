// AC-5/AC-6 depend on the canon surviving as exact bytes: export is a
// line-span patch over the original text, not a re-serialisation. If a trip
// through Postgres altered so much as a line ending, every export would differ
// by invisible whitespace. This proves it does not.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { requireUrl } from './env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();
const row = (
  await client.query(
    `select d.input_yaml, d.output_yaml
       from rounds r join datasets d on d.id = r.dataset_id
      where r.status = 'open'`,
  )
).rows[0];
await client.end();

if (!row) {
  console.error('No open round with a dataset. Run `npm run db:seed` first.');
  process.exit(1);
}

let failed = 0;
for (const [name, file, stored] of [
  ['input', 'data/input_tier_scenarios.yaml', row.input_yaml],
  ['output', 'data/output_behavior_scenarios.yaml', row.output_yaml],
]) {
  const onDisk = readFileSync(resolve(ROOT, file));
  const fromDb = Buffer.from(stored, 'utf8');
  const identical = onDisk.equals(fromDb);
  if (!identical) failed += 1;

  console.log(`${name}`);
  console.log(`  disk   ${onDisk.length} bytes  sha256 ${sha(onDisk).slice(0, 16)}…`);
  console.log(`  db     ${fromDb.length} bytes  sha256 ${sha(fromDb).slice(0, 16)}…`);
  console.log(
    `  chars  ${stored.length} (${onDisk.length - stored.length} more bytes than characters — multi-byte UTF-8)`,
  );
  console.log(`  BYTE-IDENTICAL: ${identical}\n`);
}

process.exit(failed === 0 ? 0 : 1);
