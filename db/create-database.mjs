// One-time bootstrap: create the `rung` database and a least-privilege app
// role. Run with `npm run db:create`.
//
// Kept separate from the migration runner because CREATE DATABASE cannot run
// inside a transaction and needs a connection to a *different* database than
// the one it creates.

import pg from 'pg';
import { env as readEnv } from './env.mjs';

const DB_NAME = 'rung';
const APP_ROLE = 'rung_app';

async function main() {
  const env = readEnv();
  const adminUrl = env.ADMIN_DATABASE_URL;
  if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set. Copy .env.example to .env.');

  const appPassword = env.APP_DB_PASSWORD;

  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  console.log(`Connected as admin to ${new URL(adminUrl).host}`);

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

    if (!appPassword) {
      console.log(
        `\nSkipping the ${APP_ROLE} role: APP_DB_PASSWORD is not set.\n` +
          `Add it to .env and re-run to create a least-privilege role for the API.`,
      );
      return;
    }

    // CREATE/ALTER ROLE are utility statements — Postgres rejects bind
    // parameters in them, so the password has to be an escaped literal.
    const pw = client.escapeLiteral(appPassword);
    const role = await client.query('select 1 from pg_roles where rolname = $1', [APP_ROLE]);
    if (role.rowCount > 0) {
      await client.query(`alter role ${APP_ROLE} with login password ${pw}`);
      console.log(`Role "${APP_ROLE}" already existed — password reset.`);
    } else {
      await client.query(`create role ${APP_ROLE} with login password ${pw}`);
      console.log(`Created role "${APP_ROLE}".`);
    }
    await client.query(`grant connect on database ${DB_NAME} to ${APP_ROLE}`);
    console.log(`Granted connect on "${DB_NAME}" to "${APP_ROLE}".`);
  } finally {
    await client.end();
  }

  if (appPassword) await grantTables(adminUrl);
}

/**
 * Table grants have to run against the `rung` database, not the maintenance
 * one. CRUD only: the app never runs DDL, and migrations run as admin.
 */
async function grantTables(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = `/${DB_NAME}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  try {
    await client.query(`grant usage on schema public to ${APP_ROLE}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema public to ${APP_ROLE}`,
    );
    await client.query(`grant usage, select on all sequences in schema public to ${APP_ROLE}`);
    // So tables added by a later migration are covered without a re-grant.
    await client.query(
      `alter default privileges in schema public
         grant select, insert, update, delete on tables to ${APP_ROLE}`,
    );
    await client.query(
      `alter default privileges in schema public grant usage, select on sequences to ${APP_ROLE}`,
    );
    console.log(`Granted CRUD on "${DB_NAME}" public schema to "${APP_ROLE}" (no DDL).`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`\nFailed: ${error.message}`);
  process.exit(1);
});
