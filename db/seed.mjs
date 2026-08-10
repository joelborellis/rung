// Seed a usable workspace: the owner, the first dataset from the canonical
// YAML on disk, and an open round. Idempotent — safe to re-run.
//
//   node db/seed.mjs --owner-email joel@gametolearn.com --owner-name "Joel B"
//
// Prints the owner's invite link once. The raw token is not recoverable
// afterwards; re-run with --reissue to mint a new one.

import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const has = (name) => process.argv.includes(`--${name}`);

const OWNER_EMAIL = String(arg('owner-email', 'joel@gametolearn.com')).toLowerCase();
const OWNER_NAME = arg('owner-name', 'Joel B');
const ROUND_LABEL = arg('round', 'Batch 1');
const BASE_URL = arg('base-url', readEnv().APP_BASE_URL ?? 'http://localhost:5173');

// Mirrors api/src/tokens.ts. Duplicated deliberately: this is a plain .mjs
// operator script and should not depend on the API's TypeScript build.
function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}

function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The client-side djb2 from src/store/persist.ts — must match exactly. */
function fileHash(...texts) {
  let hash = 5381;
  for (const text of texts) {
    for (let i = 0; i < text.length; i += 1) {
      hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
  }
  return hash.toString(36);
}

/** Scenario ids, without parsing YAML: top-level list items with an id. */
function scenarioIds(yaml) {
  const ids = [];
  for (const line of yaml.split(/\r?\n/)) {
    const match = /^\s*-\s+id:\s*["']?([A-Za-z0-9_\-.]+)["']?\s*$/.exec(line);
    if (match) ids.push(match[1]);
  }
  return ids;
}

const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();
await client.query('begin');

try {
  // --- owner -------------------------------------------------------------
  let owner = (
    await client.query('select id, display_name, role from people where email = $1', [OWNER_EMAIL])
  ).rows[0];

  if (!owner) {
    owner = (
      await client.query(
        `insert into people (email, display_name, role) values ($1, $2, 'owner')
         returning id, display_name, role`,
        [OWNER_EMAIL, OWNER_NAME],
      )
    ).rows[0];
    console.log(`Created owner ${OWNER_EMAIL}`);
  } else {
    if (owner.role !== 'owner') {
      await client.query(`update people set role = 'owner' where id = $1`, [owner.id]);
      console.log(`Promoted ${OWNER_EMAIL} to owner`);
    } else {
      console.log(`Owner ${OWNER_EMAIL} already exists`);
    }
  }

  // --- invite ------------------------------------------------------------
  const live = await client.query(
    'select id from invites where person_id = $1 and revoked_at is null',
    [owner.id],
  );

  let link = null;
  if (live.rowCount > 0 && !has('reissue')) {
    console.log(`Owner already has a live invite. Re-run with --reissue to mint a new link.`);
  } else {
    if (live.rowCount > 0) {
      await client.query('update invites set revoked_at = now() where person_id = $1 and revoked_at is null', [owner.id]);
      console.log(`Revoked ${live.rowCount} existing invite(s)`);
    }
    const minted = mintToken();
    await client.query(
      `insert into invites (person_id, token_prefix, token_hash, created_by)
       values ($1, $2, $3, $1)`,
      [owner.id, minted.prefix, minted.hash],
    );
    link = `${BASE_URL.replace(/\/+$/, '')}/#/t/${minted.token}`;
  }

  // --- dataset + round ---------------------------------------------------
  const inputYaml = readFileSync(resolve(ROOT, 'data/input_tier_scenarios.yaml'), 'utf8');
  const outputYaml = readFileSync(resolve(ROOT, 'data/output_behavior_scenarios.yaml'), 'utf8');
  const ids = { input: scenarioIds(inputYaml), output: scenarioIds(outputYaml) };
  const digest = sha256Hex(inputYaml + outputYaml);

  console.log(`Canon: ${ids.input.length} input + ${ids.output.length} output scenarios`);
  if (ids.input.length === 0 || ids.output.length === 0) {
    throw new Error('Found no scenario ids — the id-scanning regex needs revisiting.');
  }

  let round = (await client.query(`select id, label from rounds where status = 'open'`)).rows[0];
  if (round) {
    console.log(`Round "${round.label}" is already open`);
  } else {
    round = (
      await client.query(`insert into rounds (label) values ($1) returning id, label`, [ROUND_LABEL])
    ).rows[0];
    console.log(`Opened round "${round.label}"`);
  }

  const existing = await client.query(
    'select id from datasets where round_id = $1 and sha256 = $2',
    [round.id, digest],
  );
  let datasetId = existing.rows[0]?.id;
  if (datasetId) {
    console.log('Dataset with these exact bytes already attached');
  } else {
    datasetId = (
      await client.query(
        `insert into datasets (round_id, label, input_yaml, output_yaml, file_hash, sha256, scenario_ids, uploaded_by)
         values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning id`,
        [
          round.id,
          'Canonical YAML at seed time',
          inputYaml,
          outputYaml,
          fileHash(inputYaml, outputYaml),
          digest,
          JSON.stringify(ids),
          owner.id,
        ],
      )
    ).rows[0].id;
    console.log('Attached dataset');
  }
  await client.query('update rounds set dataset_id = $1 where id = $2', [datasetId, round.id]);

  await client.query(
    `insert into round_participants (round_id, person_id) values ($1, $2)
     on conflict do nothing`,
    [round.id, owner.id],
  );

  await client.query('commit');

  if (link) {
    console.log(`\n  Owner link (shown once — save it now):\n\n  ${link}\n`);
  }
  console.log('Seed complete.');
} catch (error) {
  await client.query('rollback');
  console.error(`\nSeed failed and was rolled back: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
