// Connect AS the app role and confirm the privilege boundary is real: CRUD
// works, DDL does not. Cheap insurance against a grant that looked right in
// the script but did not land.

import pg from 'pg';
import { requireUrl } from './env.mjs';

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

// DATABASE_URL *is* the app role — that is the point of this check.
const client = new pg.Client({ connectionString: requireUrl('DATABASE_URL') });
await client.connect();
const who = await client.query('select current_user, current_database()');
console.log(`\nConnected as ${who.rows[0].current_user} to ${who.rows[0].current_database}\n`);

await client.query('begin');
try {
  try {
    await client.query('select count(*) from people');
    ok('can SELECT');
  } catch (e) {
    bad('can SELECT', e.message);
  }

  try {
    await client.query(
      `insert into people (email, display_name) values ('probe@example.com', 'Probe')`,
    );
    ok('can INSERT');
  } catch (e) {
    bad('can INSERT', e.message);
  }

  try {
    await client.query(`update people set display_name = 'Probe2' where email = 'probe@example.com'`);
    ok('can UPDATE');
  } catch (e) {
    bad('can UPDATE', e.message);
  }

  try {
    await client.query(`delete from people where email = 'probe@example.com'`);
    ok('can DELETE');
  } catch (e) {
    bad('can DELETE', e.message);
  }

  // Every table the API writes to, so a missing grant on a table added by a
  // later migration shows up here rather than as a 500 in front of a clinician.
  for (const table of [
    'people',
    'rounds',
    'datasets',
    'round_participants',
    'reviews',
    'proposals',
    'resolutions',
    'exports',
    'review_history',
  ]) {
    try {
      await client.query(`select count(*) from ${table}`);
      ok(`can read ${table}`);
    } catch (e) {
      bad(`can read ${table}`, e.message.split('\n')[0]);
    }
  }

  // The history trigger runs as the invoking role, so writing a review implies
  // inserting into review_history. A missing grant there would surface as a
  // failure to save a verdict, which is the worst place to find it.
  try {
    await client.query(
      `insert into review_history (round_id, person_id, scenario_id, snapshot, reason)
       values (gen_random_uuid(), gen_random_uuid(), 'probe', '{}'::jsonb, 'import')`,
    );
    ok('can INSERT into review_history (the conflict trigger needs this)');
  } catch (e) {
    bad('can INSERT into review_history', e.message.split('\n')[0]);
  }

  for (const [label, sql] of [
    ['cannot CREATE TABLE', 'create table should_not_exist (id int)'],
    ['cannot DROP TABLE', 'drop table people'],
    ['cannot ALTER TABLE', 'alter table people add column sneaky int'],
    ['cannot CREATE ROLE', "create role sneaky with login password 'x'"],
  ]) {
    await client.query('savepoint s');
    try {
      await client.query(sql);
      await client.query('rollback to savepoint s');
      bad(label, 'statement was ACCEPTED — the app role has DDL rights it should not');
    } catch (e) {
      await client.query('rollback to savepoint s');
      if (/permission denied|must be owner/i.test(e.message)) ok(label);
      else bad(label, `blocked, but not by permissions: ${e.message}`);
    }
  }
} finally {
  await client.query('rollback');
  await client.end();
}

// Blast radius: this server hosts other databases. Postgres has no
// cross-database queries, so the only route is a separate connection — check
// whether the app role can open one. Reported rather than asserted, because
// PUBLIC holds CONNECT on every database by default and revoking it would
// affect whatever else lives here.
const otherDbs = await (async () => {
  const admin = new URL(requireUrl('ADMIN_DATABASE_URL'));
  const probe = new pg.Client({ connectionString: (() => {
    admin.pathname = '/postgres';
    return admin.toString();
  })() });
  try {
    await probe.connect();
    const r = await probe.query(
      `select datname from pg_database
        where datistemplate = false and datname not in ('postgres', 'rung')`,
    );
    return r.rows.map((x) => x.datname);
  } catch {
    return [];
  } finally {
    await probe.end().catch(() => {});
  }
})();

if (otherDbs.length > 0) {
  const appUrl = new URL(requireUrl('DATABASE_URL'));
  console.log(`\nOther databases on this server: ${otherDbs.join(', ')}`);
  for (const name of otherDbs) {
    appUrl.pathname = `/${name}`;
    const probe = new pg.Client({ connectionString: appUrl.toString(), connectionTimeoutMillis: 8000 });
    try {
      await probe.connect();
      const tables = await probe.query(
        `select count(*)::int as n from information_schema.tables
          where table_schema = 'public'`,
      );
      const readable = await probe
        .query(`select count(*) from information_schema.tables where table_schema='public'
                  and has_table_privilege(current_user, format('%I.%I', table_schema, table_name), 'SELECT')`)
        .then((r) => Number(r.rows[0].count))
        .catch(() => 0);
      console.log(
        `  NOTE  the app role CAN connect to "${name}" ` +
          `(${tables.rows[0].n} public tables, ${readable} readable by it)`,
      );
      if (readable > 0) {
        console.log(
          `        ${readable} table(s) there are readable. To close that: ` +
            `revoke connect on database ${name} from public;`,
        );
      }
      await probe.end();
    } catch (error) {
      if (/permission denied|not permitted/i.test(error.message)) {
        console.log(`  GOOD  the app role cannot connect to "${name}"`);
      } else {
        console.log(`  ?     "${name}": ${error.message.split('\n')[0]}`);
      }
      await probe.end().catch(() => {});
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed. (All changes rolled back.)`);
process.exit(failed === 0 ? 0 : 1);
