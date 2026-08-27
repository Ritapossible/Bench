import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * as schema from './schema.js';
export { PgCatalogRepository } from './catalog-repository.js';
export { PgHireStore } from './hire-store.js';
export { runMigrations, migrationUrl } from './migrate.js';
export { PgAuditionStore } from './audition-store.js';
export type Db = ReturnType<typeof createDb>;

/**
 * Pools are cached per connection string, per process.
 *
 * On a long-lived server this is a convenience. On serverless it is a
 * correctness issue: the web app builds one client for the catalog and another
 * for the hire store, and without this each opens its own pool - so every warm
 * instance holds two pools of ten, and a handful of instances exhausts a Neon
 * project's connection limit while almost every one of those connections sits
 * idle. Keyed by connection string so a direct URL and a pooled URL stay
 * separate, which is what migrations rely on.
 */
const globalForDb = globalThis as unknown as { __benchPools?: Map<string, pg.Pool> };
const pools = (globalForDb.__benchPools ??= new Map<string, pg.Pool>());

/**
 * Serverless-shaped defaults.
 *
 * `max` is small because concurrency in a serverless deployment comes from more
 * instances, not more connections per instance - a large per-instance pool just
 * multiplies the connection count by the number of warm lambdas. The idle
 * timeout is short for the same reason: a frozen instance should not keep
 * holding connections it cannot use.
 *
 * `connectionTimeoutMillis` matters more than it looks on Neon, whose compute
 * suspends when idle: the first request after a scale-to-zero waits for a cold
 * start, and pg's default of "wait forever" turns that into a hung request
 * rather than a slow one.
 */
export interface DbOptions {
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
}

const SERVERLESS =
  process.env['VERCEL'] !== undefined || process.env['AWS_LAMBDA_FUNCTION_NAME'] !== undefined;

export function createDb(connectionString: string, opts: DbOptions = {}) {
  let pool = pools.get(connectionString);
  if (pool === undefined) {
    pool = new pg.Pool({
      connectionString,
      max: opts.max ?? (SERVERLESS ? 3 : 10),
      idleTimeoutMillis: opts.idleTimeoutMillis ?? (SERVERLESS ? 10_000 : 30_000),
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 15_000,
    });
    // A pool that emits 'error' with no listener takes the process down. An
    // idle backend being closed by Neon is routine, not fatal: the pool
    // discards the client and the next query opens a new one.
    pool.on('error', (err) => {
      console.error('[bench:db] idle client error (pool will recover):', err.message);
    });
    pools.set(connectionString, pool);
  }
  return drizzle(pool, { schema });
}
