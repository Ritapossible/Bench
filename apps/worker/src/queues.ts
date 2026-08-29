import type { RedisOptions } from 'ioredis';

/**
 * Queue names and cadences in one place, so "how often does Bench probe?" is
 * answered by reading one file rather than by grepping for `every:`.
 */
export const QUEUE = {
  indexer: 'bench:indexer',
  prober: 'bench:prober',
  anchor: 'bench:anchor',
  audition: 'bench:audition',
  scorer: 'bench:scorer',
  crossref: 'bench:crossref',
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
   * length of a replayed window. Hourly, and the runner bounds concurrency
   * inside a tick.
   */
  audition: 60 * 60_000,
  /** Cheap - reads recorded outcomes. Runs shortly after auditions land. */
  scorer: 10 * 60_000,
  /**
   * One upstream call per agent, so this is paced and must never sit in a page
   * render. Twice an hour is far inside any tier's daily quota.
   */
  crossref: 30 * 60_000,
} as const;

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection its workers
 * use — with a retry limit, a blocking command that outlives a Redis blip
 * throws and kills the worker instead of reconnecting.
 */
export function redisOptionsFrom(url: string): { connection: RedisOptions } {
  const parsed = new URL(url);
  return {
    connection: {
      host: parsed.hostname,
      port: Number(parsed.port === '' ? 6379 : parsed.port),
      ...(parsed.password === '' ? {} : { password: parsed.password }),
      ...(parsed.username === '' ? {} : { username: parsed.username }),
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
