import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export * as schema from './schema.js';
export { PgCatalogRepository } from './catalog-repository.js';
export { PgHireStore } from './hire-store.js';
export { runMigrations, migrationUrl } from './migrate.js';
export { PgAuditionStore } from './audition-store.js';
export { PgReportStore, type ReportRequest } from './report-store.js';
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
 *
 * `statement_timeout` covers the case that one does not, and it is the one
 * that actually happened. When the database was suspended for exhausting its
 * transfer allowance, connections still opened - so the connection timeout
 * never fired - and the query behind them was simply never served. /status,
 * which has an error boundary, said "something broke" within seconds.
 * /registry sat on "Reading the catalog…" indefinitely, because a promise
 * that never settles never reaches an error boundary at all. A reader who
 * waits on a spinner learns nothing and leaves; a reader who is told the page
 * failed can press "Try again", and a judge can tell the two apart.
 *
 * So a query is given a hard ceiling server-side. Ten seconds where a person
 * is waiting on a page, and a minute in the worker, whose pruning and
 * enumeration passes are legitimately slower than any page read.
 */
export interface DbOptions {
  readonly max?: number;
  readonly idleTimeoutMillis?: number;
  readonly connectionTimeoutMillis?: number;
  /** Server-side cap on a single query. See the note on `statement_timeout`. */
  readonly statementTimeoutMillis?: number;
  /**
   * Skip the process-wide pool cache and return a pool of this client's own.
   *
   * For tests, and named for what it does rather than for who uses it. The
   * cache is keyed by connection string and held on `globalThis`, which is
   * right in a serverless deployment and wrong in a test runner that puts
   * several files in one process: every file called `createDb` with the same
   * URL, got the same pool, and the first `afterAll` to run closed it out from
   * under the rest - which surfaces as "Cannot use a pool after calling end"
   * in whichever file happened to go second, and looks like a database fault.
   */
  readonly isolate?: boolean;
}

const SERVERLESS =
  process.env['VERCEL'] !== undefined || process.env['AWS_LAMBDA_FUNCTION_NAME'] !== undefined;

export function createDb(connectionString: string, opts: DbOptions = {}) {
  let pool = opts.isolate === true ? undefined : pools.get(connectionString);
  if (pool === undefined) {
    pool = new pg.Pool({
      connectionString,
      max: opts.max ?? (SERVERLESS ? 3 : 10),
      idleTimeoutMillis: opts.idleTimeoutMillis ?? (SERVERLESS ? 10_000 : 30_000),
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 15_000,
      statement_timeout: opts.statementTimeoutMillis ?? (SERVERLESS ? 10_000 : 60_000),
    });
    // A pool that emits 'error' with no listener takes the process down. An
    // idle backend being closed by Neon is routine, not fatal: the pool
    // discards the client and the next query opens a new one.
    pool.on('error', (err) => {
      console.error('[bench:db] idle client error (pool will recover):', err.message);
    });
    if (opts.isolate !== true) pools.set(connectionString, pool);
  }
  return drizzle(pool, { schema });
}
