import pg, { types, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';
import type { AppConfig } from '../config.js';

/** Anything that can run SQL: the pool itself or a client checked out for a transaction. */
export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>;
}

export type Pool = pg.Pool;

// DATE (oid 1082) stays a "YYYY-MM-DD" string. The default parser builds a local-midnight Date,
// which shifts calendar dates on servers whose timezone is not the clinic's.
types.setTypeParser(1082, (value) => value);

export function createPool(
  config: Pick<AppConfig, 'databaseUrl' | 'databaseSsl' | 'databaseSslRejectUnauthorized' | 'databasePoolMax'>,
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: config.databaseSslRejectUnauthorized } : undefined,
  });
  // An idle client can be dropped by the server; log instead of crashing the process.
  pool.on('error', (error) => {
    console.error('Postgres pool error', error.message);
  });
  return pool;
}

/** Runs `fn` inside BEGIN/COMMIT on one connection. Any thrown error rolls the whole unit back. */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
