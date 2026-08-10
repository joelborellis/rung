// The connection pool.
//
// Module scope on purpose: an Azure Functions worker reuses the module across
// invocations, so the pool is created once per worker rather than per request.
// `max` is deliberately small — Consumption plans scale out to many workers,
// and each one holding a large pool is the fastest way to exhaust Postgres
// connections. Small pool per worker + PgBouncer on the server side is the
// combination that survives a scale-out.

import pg from 'pg';

/**
 * Anything that can run a query: the pool, a pooled client inside a
 * transaction, or a standalone Client. Functions take this rather than a
 * concrete type so a caller can hand them a connection already inside a
 * transaction — which is how the integration tests stay isolated, and how a
 * multi-statement operation keeps its atomicity.
 */
export type Queryable = Pick<pg.ClientBase, 'query'>;

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set.');
  }

  pool = new pg.Pool({
    connectionString,
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Azure Postgres requires TLS. `pg` treats sslmode=require in the URL as
    // verify-full, which is what we want and what the server's cert supports.
  });

  // A pool error with no listener crashes the worker. Log and let the pool
  // discard the bad client; the next query gets a fresh one.
  pool.on('error', (error) => {
    console.error('[db] idle client error:', error.message);
  });

  return pool;
}

/** Run a function inside a transaction, rolling back on any throw. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => {
      /* the connection is already gone; the original error is what matters */
    });
    throw error;
  } finally {
    client.release();
  }
}

/** For tests and scripts that need the pool actually closed. */
export async function closeDb(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
