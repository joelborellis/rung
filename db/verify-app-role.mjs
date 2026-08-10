// Connect AS the app role and confirm the privilege boundary is real: CRUD
// works, DDL does not. Cheap insurance against a grant that looked right in
// the script but did not land.

import pg from 'pg';
import { requireUrl } from './env.mjs';

let passed = 0;
let failed = 0;
const ok = (l) => (passed++, console.log(`  PASS  ${l}`));
const bad = (l, d) => (failed++, console.log(`  FAIL  ${l}\n        ${d}`));

const client = new pg.Client({ connectionString: requireUrl('APP_DATABASE_URL') });
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

  for (const [label, sql] of [
    ['cannot CREATE TABLE', 'create table should_not_exist (id int)'],
    ['cannot DROP TABLE', 'drop table people'],
    ['cannot ALTER TABLE', 'alter table people add column sneaky int'],
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

console.log(`\n${passed} passed, ${failed} failed. (All changes rolled back.)`);
process.exit(failed === 0 ? 0 : 1);
