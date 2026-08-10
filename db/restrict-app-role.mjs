// Stop the app role reaching databases that are none of its business.
//
// Postgres grants CONNECT on every database to PUBLIC by default, so `rung_app`
// can open a connection to every database on this shared server. It can read
// nothing in them — no table privileges — but a connection it has no reason to
// make is a connection worth removing, and "it can't read anything" is a weaker
// promise than "it can't get in".
//
// There is no way to revoke a PUBLIC privilege from one role, so the shape is:
// revoke from PUBLIC, then grant back explicitly to the roles that need it.
// That is why this script is careful about who those are.
//
// Reversible in one statement, printed at the end.
//
//   node db/restrict-app-role.mjs            # show what it would do
//   node db/restrict-app-role.mjs --apply    # do it

import pg from 'pg';
import { requireUrl } from './env.mjs';

const APPLY = process.argv.includes('--apply');

// Deliberately NOT touched: azure_sys and postgres are Azure-managed. The app
// role can read query-store statistics and pg_cron metadata there — not user
// data — and revoking PUBLIC on them risks breaking Azure's own tooling and
// pg_cron. That trade is not worth making for statistics about query shapes.
const AZURE_MANAGED = new Set(['azure_sys', 'azure_maintenance', 'postgres']);

const adminUrl = new URL(requireUrl('ADMIN_DATABASE_URL'));
const appRole = decodeURIComponent(new URL(requireUrl('DATABASE_URL')).username);
const ownDatabase = new URL(requireUrl('DATABASE_URL')).pathname.replace('/', '');

const maintenance = new URL(adminUrl);
maintenance.pathname = '/postgres';
const client = new pg.Client({ connectionString: maintenance.toString() });
await client.connect();

try {
  const dbs = await client.query(
    `select d.datname, pg_get_userbyid(d.datdba) as owner, d.datacl::text as acl
       from pg_database d
      where d.datistemplate = false
      order by d.datname`,
  );

  const targets = dbs.rows.filter(
    (row) => row.datname !== ownDatabase && !AZURE_MANAGED.has(row.datname),
  );

  console.log(`\nApp role: ${appRole}   Its database: ${ownDatabase}`);
  console.log(`Leaving Azure-managed databases alone: ${[...AZURE_MANAGED].join(', ')}\n`);

  if (targets.length === 0) {
    console.log('Nothing to restrict.');
  }

  for (const row of targets) {
    const publicHasConnect = row.acl === null || /(^|,)=[a-zA-Z]*c/.test(row.acl);
    if (!publicHasConnect) {
      console.log(`  already restricted: ${row.datname}`);
      continue;
    }

    const id = client.escapeIdentifier(row.datname);
    const ownerId = client.escapeIdentifier(row.owner);

    if (!APPLY) {
      console.log(`  would revoke: revoke connect on database ${row.datname} from public;`);
      console.log(`                (owner ${row.owner} keeps access; re-run with --apply)`);
      continue;
    }

    // Grant the owner explicitly first. Once the ACL stops being null the
    // implicit defaults no longer apply, and losing the owner's own access to
    // a database is a bad way to find that out.
    await client.query(`grant connect on database ${id} to ${ownerId}`);
    await client.query(`revoke connect on database ${id} from public`);
    console.log(`  revoked PUBLIC connect on "${row.datname}" (owner ${row.owner} kept)`);
  }

  if (APPLY && targets.length > 0) {
    console.log('\nVerifying…');
    for (const row of targets) {
      // The app role must be locked out.
      const appTest = new URL(requireUrl('DATABASE_URL'));
      appTest.pathname = `/${row.datname}`;
      const asApp = new pg.Client({ connectionString: appTest.toString(), connectionTimeoutMillis: 8000 });
      try {
        await asApp.connect();
        console.log(`  FAIL  ${appRole} can still connect to "${row.datname}"`);
        await asApp.end();
      } catch (error) {
        const denied = /permission denied|not permitted/i.test(error.message);
        console.log(
          denied
            ? `  ok    ${appRole} is refused by "${row.datname}"`
            : `  ?     ${appRole} blocked by something else: ${error.message.split('\n')[0]}`,
        );
        await asApp.end().catch(() => {});
      }

      // And the owner must NOT be — this is the check that protects whatever
      // else uses that database.
      const ownerTest = new URL(adminUrl);
      ownerTest.pathname = `/${row.datname}`;
      const asOwner = new pg.Client({ connectionString: ownerTest.toString(), connectionTimeoutMillis: 8000 });
      try {
        await asOwner.connect();
        await asOwner.query('select 1');
        console.log(`  ok    ${row.owner} can still connect to "${row.datname}"`);
        await asOwner.end();
      } catch (error) {
        console.log(`  FAIL  ${row.owner} LOST access to "${row.datname}": ${error.message.split('\n')[0]}`);
        console.log(`        undo with: grant connect on database ${row.datname} to public;`);
        await asOwner.end().catch(() => {});
      }
    }

    console.log(
      '\nIf something else on this server used PUBLIC to reach one of these,\n' +
        'grant it back explicitly:  grant connect on database <name> to <role>;\n' +
        'Or undo entirely:          grant connect on database <name> to public;\n',
    );
  }
} finally {
  await client.end();
}
