// The .review.json import path.
//
// Two jobs: migrating work done before the backend existed, and rescuing a
// counselor whose sync never worked. Nobody exercises it day to day, which is
// exactly why it needs a test — an escape hatch discovered to be broken on the
// day it is needed is not an escape hatch.
//
// Requires `npm run api:dev`.

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { requireUrl, env as readEnv } from './env.mjs';

const BASE = readEnv().API_BASE_URL ?? 'http://localhost:7071';
const TAG = `import-${randomUUID().slice(0, 8)}`;

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

function mintToken() {
  const prefix = randomBytes(4).toString('hex');
  const token = `rung_${prefix}_${randomBytes(32).toString('base64url')}`;
  return { token, prefix, hash: createHash('sha256').update(token, 'utf8').digest() };
}

function makeClient() {
  let cookie = null;
  return async (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (cookie) headers.cookie = cookie;
    if (init.body) headers['content-type'] = 'application/json';
    const response = await fetch(`${BASE}${path}`, { ...init, headers });
    const set = response.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await response.text();
    return { status: response.status, text, json: text ? JSON.parse(text) : null };
  };
}

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

/** A review file exactly as the app exports one, with a pre-backend slug id. */
function reviewFile(slugId, displayName, reviews) {
  return {
    format: 'srs.review',
    version: 1,
    exportedAt: minutesAgo(5),
    overlay: {
      reviewer: { id: slugId, displayName, credentials: 'LPC' },
      reviews,
      proposals: [
        {
          tempId: 'new-legacy-001',
          targetFile: 'input',
          authorId: slugId,
          status: 'submitted',
          scenario: { category: 'ambiguous_boundary', description: 'LEGACY-PROPOSAL' },
        },
      ],
    },
  };
}

const verdict = (scenarioId, because, at) => ({
  scenarioId,
  reviewerId: 'placeholder',
  reviewedAt: at,
  labelVerdict: { kind: 'change', proposed: 'pause_and_route', because },
  rationaleVerdict: { kind: 'sound' },
  realismVerdict: { kind: 'realistic' },
  hardCase: false,
});

const db = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await db.connect();
const made = [];

try {
  const round = await db.query(`select id from rounds where status = 'open'`);
  if (round.rowCount === 0) throw new Error('No open round. Run `npm run db:seed` first.');
  const roundId = round.rows[0].id;

  const ownerRow = await db.query(`select id from people where role = 'owner' limit 1`);
  if (ownerRow.rowCount === 0) throw new Error('No owner. Run `npm run db:seed` first.');
  const ownerId = ownerRow.rows[0].id;
  const minted = mintToken();
  await db.query(`insert into invites (person_id, token_prefix, token_hash) values ($1,$2,$3)`, [
    ownerId,
    minted.prefix,
    minted.hash,
  ]);

  console.log(`\nReview-file import (${BASE})\n`);

  const asOwner = makeClient();
  const signIn = await asOwner('/api/session', {
    method: 'POST',
    body: JSON.stringify({ token: minted.token }),
  });
  if (signIn.status !== 200) throw new Error(`sign-in failed: ${signIn.text}`);
  ok('owner signs in');

  const email = `${TAG}-legacy@example.com`;
  const file = reviewFile('jane-doe', 'Jane Doe', {
    'routine-001': verdict('routine-001', 'LEGACY-VERDICT-ONE', minutesAgo(120)),
    'routine-002': verdict('routine-002', 'LEGACY-VERDICT-TWO', minutesAgo(110)),
  });

  // --- an unknown reviewer needs an email to link to -----------------------
  const noEmail = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify(file),
  });
  if (noEmail.status === 400 && /email/i.test(noEmail.text)) {
    ok('an unknown reviewer is refused until an email links them to a person');
  } else {
    bad('need-email guard', `${noEmail.status} ${noEmail.text.slice(0, 200)}`);
  }

  // --- the real import ------------------------------------------------------
  const first = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ ...file, email }),
  });
  if (first.status !== 200) throw new Error(`import failed: ${first.text}`);
  made.push(first.json.person.id);

  if (first.json.imported === 2) ok('imports both verdicts');
  else bad('import count', JSON.stringify(first.json));

  const person = await db.query(
    'select id, email, legacy_slug, display_name from people where email = $1',
    [email],
  );
  if (person.rows[0]?.legacy_slug === 'jane-doe') {
    ok('the pre-backend slug id is recorded so the same file re-imports cleanly');
  } else {
    bad('legacy_slug', JSON.stringify(person.rows[0]));
  }

  // The verdicts must be filed under the new UUID, not the slug.
  const stored = await db.query(
    `select scenario_id, label_verdict from reviews where round_id = $1 and person_id = $2
      order by scenario_id`,
    [roundId, person.rows[0].id],
  );
  if (stored.rowCount === 2) ok('the verdicts are filed under the real person id');
  else bad('remap', `${stored.rowCount} rows`);

  const proposals = await db.query(
    'select temp_id, scenario from proposals where round_id = $1 and author_id = $2',
    [roundId, person.rows[0].id],
  );
  if (proposals.rowCount === 1 && proposals.rows[0].scenario.description === 'LEGACY-PROPOSAL') {
    ok('the authored scenario comes across too');
  } else {
    bad('proposals', JSON.stringify(proposals.rows));
  }

  // --- idempotency ----------------------------------------------------------
  const again = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ ...file, email }),
  });
  const afterReplay = await db.query(
    'select count(*)::int as n from reviews where round_id = $1 and person_id = $2',
    [roundId, person.rows[0].id],
  );
  if (again.status === 200 && afterReplay.rows[0].n === 2) {
    ok('re-importing the same file does not duplicate anything');
  } else {
    bad('idempotent import', `${again.status}, ${afterReplay.rows[0].n} rows`);
  }

  // --- merge, not overwrite -------------------------------------------------
  // A counselor who has since worked in the app must not lose that work to an
  // older file the owner happens to import afterwards.
  await db.query(
    // Both casts explicit: one parameter feeding a text column and a
    // timestamptz one leaves Postgres unable to deduce a single type.
    `update reviews set label_verdict = $3::jsonb,
            reviewed_at_iso = $4::text, reviewed_at = $4::timestamptz
      where round_id = $1 and person_id = $2 and scenario_id = 'routine-001'`,
    [
      roundId,
      person.rows[0].id,
      JSON.stringify({ kind: 'change', proposed: 'crisis_protocol', because: 'NEWER-IN-APP' }),
      minutesAgo(1),
    ],
  );
  await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ ...file, email }),
  });
  const merged = await db.query(
    `select label_verdict from reviews where round_id = $1 and person_id = $2
      and scenario_id = 'routine-001'`,
    [roundId, person.rows[0].id],
  );
  if (merged.rows[0].label_verdict.because === 'NEWER-IN-APP') {
    ok('an older file does not overwrite newer work done in the app');
  } else {
    bad('merge policy', JSON.stringify(merged.rows[0].label_verdict));
  }

  // --- scenarios not in this batch -----------------------------------------
  const strayFile = reviewFile('jane-doe', 'Jane Doe', {
    'ghost-999': verdict('ghost-999', 'FROM-ANOTHER-SET', minutesAgo(90)),
  });
  const stray = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ ...strayFile, email }),
  });
  if (stray.json.skipped?.includes('ghost-999')) {
    ok('a verdict for a scenario not in this batch is named, not dropped silently');
  } else {
    bad('skipped reporting', JSON.stringify(stray.json));
  }

  // --- garbage in ------------------------------------------------------------
  const notAFile = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ hello: 'world' }),
  });
  if (notAFile.status === 400) ok('a file that is not a review file is refused');
  else bad('format guard', `${notAFile.status}`);

  const wrongVersion = await asOwner('/api/admin/overlays/import', {
    method: 'POST',
    body: JSON.stringify({ ...file, version: 99, email }),
  });
  if (wrongVersion.status === 400 && /version/i.test(wrongVersion.text)) {
    ok('a future file version is refused rather than half-read');
  } else {
    bad('version guard', `${wrongVersion.status}`);
  }
} catch (error) {
  bad('harness', error.stack ?? error.message);
} finally {
  if (made.length > 0) {
    await db.query('delete from reviews where person_id = any($1::uuid[])', [made]);
    await db.query('delete from proposals where author_id = any($1::uuid[])', [made]);
    await db.query('delete from round_participants where person_id = any($1::uuid[])', [made]);
    await db.query('delete from invites where person_id = any($1::uuid[])', [made]);
    await db.query('delete from people where id = any($1::uuid[])', [made]);
  }
  await db.query(`delete from invites where person_id = (select id from people where role='owner' limit 1) and use_count > 0 and created_at > now() - interval '5 minutes'`);
  await db.end();
}

console.log(`\n${passed} passed, ${failed} failed. (Test rows removed.)`);
process.exit(failed === 0 ? 0 : 1);
