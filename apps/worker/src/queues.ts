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

/**
 * ============================================================================
 * A note on why these are not faster.
 * ============================================================================
 *
 * The hosted Postgres suspended itself for exhausting a 5 GB monthly network
 * transfer allowance, and took the whole site down with it: every page reads
 * the catalog per request, so a suspended database is a blank catalog, a
 * hanging registry page and a 500 on /status.
 *
 * The cause was this file. The prober ran every 60 seconds against a batch of
 * 200, which is 288,000 probe rows a day - about 8.6 million a month, plus the
 * query that selects each batch, plus the rolling summary rewritten on every
 * write, plus a pruning pass. Nothing about the product needed that: "verified
 * live" requires three probes inside six hours, and there are on the order of
 * a thousand endpoints to cover. Probing all of them once an hour is already
 * six times more often than the rule asks for.
 *
 * So these cadences are set by what the definitions actually require, rather
 * than by how fresh it would be nice for things to be:
 *
 *   prober   5 min x 200 =  2,400/hour, against ~1,700 endpoints and a 6-hour
 *                           rule. Covers the whole set every ~45 minutes.
 *   indexer  5 min       =  a new registration appears within five minutes.
 *                           It was 30s, which bought nothing a reader notices.
 *   scorer   30 min      =  reads recorded outcomes; auditions land far slower
 *                           than this.
 *   crossref 60 min      =  one upstream call per agent, and the least
 *                           time-sensitive number on the site.
 *
 * The report queue is deliberately untouched at 20 seconds: a person is
 * watching a page wait on it, and its tick is a single cheap claim query
 * rather than a batch of writes.
 */
export const CADENCE_MS = {
  /**
   * Registry reads are cheap and new agents should appear quickly — a
   * catalog that lags registration by an hour looks broken during a demo.
   */
  indexer: 300_000,
  /**
   * Probes hit third-party hosts. Fast enough that "verified live" means now,
   * slow enough that Bench is not the reason someone's agent falls over.
   */
  prober: 300_000,
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
  scorer: 30 * 60_000,
  /**
   * One upstream call per agent, so this is paced and must never sit in a page
   * render. Twice an hour is far inside any tier's daily quota.
   */
  crossref: 60 * 60_000,
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

/**
 * Replace a queue's schedule, rather than adding another one beside it.
 *
 * BullMQ derives a repeatable job's key from its name *and* its repeat
 * options, so `add('tick', {}, { repeat: { every: 300_000 } })` does not
 * update an existing `every: 60_000` entry - it creates a second one, and both
 * keep firing. Nothing surfaces that: the queue still works, each tick still
 * succeeds, and the only symptom is a cadence nobody configured.
 *
 * It had been happening for the life of the project. Every cadence change left
 * its predecessor behind in Redis, so a worker up 26 minutes had run the
 * prober 34 times against a 300-second setting - once every 46 seconds, six
 * times the intended rate. That matters beyond tidiness: the prober's cadence
 * is what the database transfer budget is built on, and the budget had already
 * been exhausted once, taking the whole site down with it.
 *
 * So the schedule is rebuilt from the code on every boot. Removing first makes
 * this file the single source of truth for how often anything runs, which is
 * what the comment above always claimed it was.
 */
export async function scheduleTick(
  queue: {
    getRepeatableJobs(): Promise<{ key: string }[]>;
    removeRepeatableByKey(key: string): Promise<boolean>;
    add(name: string, data: object, opts: object): Promise<unknown>;
  },
  everyMs: number,
): Promise<number> {
  const existing = await queue.getRepeatableJobs();
  for (const job of existing) await queue.removeRepeatableByKey(job.key);
  await queue.add('tick', {}, repeatOpts(everyMs));
  // Returned so the caller can say how many stale schedules it found, which is
  // the only evidence this bug ever leaves.
  return existing.length;
}
