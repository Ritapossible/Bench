import type { RedisOptions } from 'ioredis';

/**
 * Queue names and cadences in one place, so "how often does Bench probe?" is
 * answered by reading one file rather than by grepping for `every:`.
 */
/**
 * Queue names. Hyphenated, not colon-separated.
 *
 * BullMQ rejects a colon in a queue name outright - it uses `:` as its own Redis
 * key separator - and it throws at construction, so the worker died on its first
 * `new Queue` with "Queue name cannot contain :" and never reached a single
 * tick. It had never once started.
 */
export const QUEUE = {
  indexer: 'bench-indexer',
  prober: 'bench-prober',
  anchor: 'bench-anchor',
  audition: 'bench-audition',
  scorer: 'bench-scorer',
  crossref: 'bench-crossref',
  report: 'bench-report',
} as const;

export type QueueName = (typeof QUEUE)[keyof typeof QUEUE];

export const CADENCE_MS = {
  /**
   * Registry reads are cheap and new agents should appear quickly — a
   * catalog that lags registration by an hour looks broken during a demo.
   */
  indexer: 30_000,
  /**
   * Probes hit third-party hosts. Fast enough that "verified live" means now,
   * slow enough that Bench is not the reason someone's agent falls over.
   */
  prober: 60_000,
  /** Anchoring costs gas, so it batches. */
  anchor: 15 * 60_000,
  /**
   * Auditions are the expensive one: a forked chain per agent, held for the
   * length of a replayed window. The runner bounds concurrency inside a tick,
   * and the service skips any agent auditioned in the last 24 hours, so the
   * cadence controls latency to a *first* audition rather than total load.
   *
   * Fifteen minutes, not sixty. At hourly, a worker that redeploys on every
   * push - which is every deployment during a build week - almost never lived
   * long enough to reach its first fire, so the feature was unobservable
   * without being broken. Nothing re-auditions four times an hour as a result:
   * reauditionAfterMs still holds the floor.
   */
  audition: 15 * 60_000,
  /** Cheap - reads recorded outcomes. Runs shortly after auditions land. */
  scorer: 10 * 60_000,
  /**
   * One upstream call per agent, so this is paced and must never sit in a page
   * render. Twice an hour is far inside any tier's daily quota.
   */
  crossref: 30 * 60_000,
  /**
   * On-demand reports. Short, because a person is watching a page wait.
   *
   * It is a poll rather than a push because the request arrives at the web app
   * and the work happens in the worker, and the two share a database but not a
   * process. Twenty seconds is the longest a reader should sit on "queued"
   * before something starts.
   */
  report: 20_000,
} as const;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection its workers
 * use — with a retry limit, a blocking command that outlives a Redis blip
 * throws and kills the worker instead of reconnecting.
 *
 * Two details exist for the hosted case and are not cosmetic:
 *
 * `family: 0`. ioredis defaults to `family: 4`, so it asks DNS for an A record
 * and nothing else. Railway's private network is IPv6-only - `redis.railway.internal`
 * publishes an AAAA record and no A record - so the default resolves nothing and
 * the worker dies at boot with ENOTFOUND against a host that is plainly up.
 * `0` lets Node try both families.
 *
 * `rediss://` means TLS. Parsing the URL for host and port and then ignoring
 * the scheme quietly downgrades a TLS connection string to a plaintext
 * connection, which does not fail cleanly - it hangs or resets mid-handshake,
 * looking like a network fault rather than a configuration one.
 */
export function redisOptionsFrom(url: string): { connection: RedisOptions } {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'rediss:';
  return {
    connection: {
      host: parsed.hostname,
      port: Number(parsed.port === '' ? 6379 : parsed.port),
      ...(parsed.password === '' ? {} : { password: decodeURIComponent(parsed.password) }),
      ...(parsed.username === '' ? {} : { username: decodeURIComponent(parsed.username) }),
      ...(secure ? { tls: { servername: parsed.hostname } } : {}),
      family: 0,
      maxRetriesPerRequest: null,
    },
  };
}

/**
 * Repeat options shared by all three schedulers.
 *
 * `removeOnComplete` is bounded rather than false: these run on a timer
 * forever, and an unbounded completed-job list is a slow Redis memory leak
 * that only shows up after the demo has been running for a week.
 */
export const repeatOpts = (everyMs: number) => ({
  repeat: { every: everyMs },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});
