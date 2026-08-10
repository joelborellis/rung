// One-time bootstrap: create the `rung` database and the least-privilege app
// role. Run with `npm run db:create`.
//
// Kept separate from the migration runner because CREATE DATABASE cannot run
// inside a transaction and needs a connection to a *different* database than
// the one it creates.
//
// The app role's name and password are read out of DATABASE_URL rather than
// configured separately. Two copies of one password drift: you rotate the URL,
// forget the other variable, and the next `db:create` silently resets the role
// back to the old password. One source of truth means that cannot happen.

import pg from 'pg';
import { env as readEnv } from './env.mjs';

const DB_NAME = 'rung';

/** Pull the role and password the app actually connects with out of its URL. */
function appCredentials(appUrl, adminUrl) {
  const app = new URL(appUrl);
  const admin = new URL(adminUrl);

  const role = decodeMaybe(app.username);
  const password = decodeMaybe(app.password);

  if (!role) throw new Error('DATABASE_URL has no username — it should be the app role.');
  if (!password) throw new Error('DATABASE_URL has no password.');

  // The bug this catches is the one that shipped: DATABASE_URL pointing at the
  // admin account, so the "least-privilege" role exists but nothing uses it.
  if (role === decodeMaybe(admin.username)) {
    throw new Error(
      `DATABASE_URL connects as "${role}", the same account as ADMIN_DATABASE_URL.\n` +
        'DATABASE_URL must be the least-privilege app role — the API uses it.',
    );
  }
  if (app.host !== admin.host) {
    throw new Error(
      `DATABASE_URL points at ${app.host} but ADMIN_DATABASE_URL at ${admin.host}.`,
    );
  }

  return { role, password };
}

/** Percent-decode, tolerating a literal % that is not an escape sequence. */
function decodeMaybe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function main() {
  const env = readEnv();
  const adminUrl = env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set. Copy .env.example to .env.');
  const appUrl = env.DATABASE_URL;
  if (!appUrl) throw new Error('DATABASE_URL is not set. Copy .env.example to .env.');

  const { role: APP_ROLE, password } = appCredentials(appUrl, adminUrl);

  // ADMIN_DATABASE_URL points at `rung`, because that is what migrations need
  // and migrations run constantly. CREATE DATABASE cannot run while connected
  // to the database it creates, so this one step swaps to the maintenance
  // database instead of asking for a second URL that would drift.
  const maintenanceUrl = new URL(adminUrl);
  maintenanceUrl.pathname = '/postgres';

  const client = new pg.Client({ connectionString: maintenanceUrl.toString() });
  await client.connect();
  console.log(`Connected as admin to ${maintenanceUrl.host} (postgres)`);

  try {
    const exists = await client.query('select 1 from pg_database where datname = $1', [DB_NAME]);
    if (exists.rowCount > 0) {
      console.log(`Database "${DB_NAME}" already exists — leaving it alone.`);
    } else {
      // Not parameterisable: an identifier, not a value. DB_NAME is a literal
      // in this file, never user input.
      await client.query(`create database ${DB_NAME}`);
      console.log(`Created database "${DB_NAME}".`);
    }

    // CREATE/ALTER ROLE are utility statements — Postgres rejects bind
    // parameters in them, so both the identifier and the password have to be
    // escaped literals.
    const roleId = client.escapeIdentifier(APP_ROLE);
    const pw = client.escapeLiteral(password);

    const role = await client.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
    if (role.rowCount > 0) {
      await client.query(`alter role ${roleId} with login password ${pw}`);
      console.log(`Role "${APP_ROLE}" already existed — password set to match DATABASE_URL.`);
    } else {
      await client.query(`create role ${roleId} with login password ${pw}`);
      console.log(`Created role "${APP_ROLE}".`);
    }
    await client.query(`grant connect on database ${DB_NAME} to ${roleId}`);
    console.log(`Granted connect on "${DB_NAME}" to "${APP_ROLE}".`);
  } finally {
    await client.end();
  }

  await grantTables(adminUrl, APP_ROLE);
  console.log(`\nVerify the boundary with: npm run db:verify-role`);
}

/**
 * Table grants have to run against the `rung` database, not the maintenance
 * one. CRUD only: the app never runs DDL, and migrations run as admin.
 */
async function grantTables(adminUrl, appRole) {
  const url = new URL(adminUrl);
  url.pathname = `/${DB_NAME}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const roleId = client.escapeIdentifier(appRole);
  try {
    await client.query(`grant usage on schema public to ${roleId}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema public to ${roleId}`,
    );
    await client.query(`grant usage, select on all sequences in schema public to ${roleId}`);
    // So tables added by a later migration are covered without a re-grant.
    await client.query(
      `alter default privileges in schema public
         grant select, insert, update, delete on tables to ${roleId}`,
    );
    await client.query(
      `alter default privileges in schema public grant usage, select on sequences to ${roleId}`,
    );
    console.log(`Granted CRUD on "${DB_NAME}" public schema to "${appRole}" (no DDL).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
