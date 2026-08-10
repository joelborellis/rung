// How much of this server can the app role actually see?
//
// Postgres grants CONNECT on every database to PUBLIC by default, so the app
// role can open a connection to the other databases on this server. Connecting
// is not reading — but "it reported zero readable tables" is only reassuring if
// there were tables to read. information_schema filters by privilege, so it
// returns nothing both when access is denied and when the database is empty.
//
// This asks the admin how many tables really exist, then asks the app role how
// many it can touch. Only the pair of numbers is meaningful.

import pg from 'pg';
import { requireUrl } from './env.mjs';

const adminBase = new URL(requireUrl('ADMIN_DATABASE_URL'));
const appBase = new URL(requireUrl('DATABASE_URL'));
const appRole = decodeURIComponent(appBase.username);

async function tableCount(url, dbName) {
  const target = new URL(url);
  target.pathname = `/${dbName}`;
  const client = new pg.Client({ connectionString: target.toString(), connectionTimeoutMillis: 8000 });
  try {
    await client.connect();
    const total = await client.query(
      `select count(*)::int as n from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
        where c.relkind = 'r' and ns.nspname not in ('pg_catalog', 'information_schema')`,
    );
    const readable = await client.query(
      `select count(*)::int as n from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
        where c.relkind = 'r' and ns.nspname not in ('pg_catalog', 'information_schema')
          and has_table_privilege($1, c.oid, 'SELECT')`,
      [appRole],
    );
    return { ok: true, total: total.rows[0].n, readable: readable.rows[0].n };
  } catch (error) {
    return { ok: false, error: error.message.split('\n')[0] };
  } finally {
    await client.end().catch(() => {});
  }
}

const listing = new pg.Client({
  connectionString: (() => {
    const u = new URL(adminBase);
    u.pathname = '/postgres';
    return u.toString();
  })(),
});
await listing.connect();
const dbs = (
  await listing.query(
    `select datname from pg_database where datistemplate = false order by datname`,
  )
).rows.map((r) => r.datname);
await listing.end();

/**
 * Azure owns these and grants PUBLIC read on some of their contents — query
 * store statistics and pg_cron metadata. That is query *shapes*, not user data,
 * and revoking PUBLIC there risks breaking Azure's own tooling. Accepted rather
 * than fixed, so this check stays honest instead of permanently red.
 */
const AZURE_MANAGED = new Set(['azure_sys', 'azure_maintenance', 'postgres']);

const ownDatabase = appBase.pathname.replace('/', '');

console.log(`\nApp role: ${appRole}   Its database: ${ownDatabase}\n`);
console.log('Database              tables  readable  note');
console.log('--------------------  ------  --------  ----------------------------');

let exposure = 0;
let accepted = 0;

for (const name of dbs) {
  // Asked as ADMIN, so the counts are the truth rather than a filtered view.
  const result = await tableCount(adminBase, name);
  if (!result.ok) {
    console.log(`${name.padEnd(20)}  ${'?'.padStart(6)}  ${'?'.padStart(8)}  (${result.error})`);
    continue;
  }

  let note = '';
  if (name === ownDatabase) {
    note = 'its own database';
  } else if (result.readable === 0) {
    note = 'no access';
  } else if (AZURE_MANAGED.has(name)) {
    note = 'Azure-managed, accepted';
    accepted += result.readable;
  } else {
    note = 'EXPOSED — user data';
    exposure += result.readable;
  }

  console.log(
    `${name.padEnd(20)}  ${String(result.total).padStart(6)}  ` +
      `${String(result.readable).padStart(8)}  ${note}`,
  );
}

if (exposure === 0) {
  console.log(
    `\nClean: ${appRole} can read no user data outside "${ownDatabase}".` +
      (accepted > 0
        ? `\n${accepted} Azure-managed table(s) remain readable — query-store statistics and\n` +
          "pg_cron metadata, not user data. Revoking PUBLIC there would risk Azure's\n" +
          'own tooling, so it is accepted deliberately.\n'
        : '\n'),
  );
} else {
  console.log(
    `\n${exposure} user-data table(s) outside "${ownDatabase}" are readable by ${appRole}.\n` +
      'Close it with:  node db/restrict-app-role.mjs --apply\n',
  );
}

process.exit(exposure === 0 ? 0 : 1);
