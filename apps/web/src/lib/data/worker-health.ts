import 'server-only';

/**
 * The worker's own report, fetched for the status page.
 *
 * The worker runs on a different host from the web app - it is a long-lived
 * process holding six timers, which is the one thing a serverless deployment
 * cannot be - so its health is not in the database and cannot be inferred from
 * the catalog. It is read over HTTP from the endpoint the worker already
 * serves.
 *
 * Not through `safeFetch`: that exists for URLs written by strangers who
 * register agents, and applies address filtering to keep those from reaching
 * internal infrastructure. This URL *is* our infrastructure, configured by the
 * operator, and running it through a filter designed to block internal
 * addresses would reject a private-network worker URL - the correct way to
 * deploy one.
 */
export interface WorkerQueue {
  readonly name: string;
  readonly ticks: number;
  readonly failures: number;
  readonly secondsSinceLastOk: number | null;
  readonly lastResult: string | null;
  readonly lastFailure: string | null;
  readonly idleStreak: number;
}

export type WorkerHealth =
  | { readonly status: 'unconfigured' }
  | { readonly status: 'unreachable'; readonly reason: string }
  | {
      readonly status: 'up' | 'degraded';
      readonly uptimeSeconds: number;
      readonly attention: readonly string[];
      readonly queues: readonly WorkerQueue[];
      /**
       * True when the worker served status but withheld per-queue detail
       * because this deployment holds no health token.
       *
       * Surfaced rather than rendered as an empty table: "no queues" and "you
       * were not shown the queues" are different claims, and the second one is
       * a configuration problem someone can fix.
       */
      readonly detailWithheld: boolean;
      /**
       * Whether an audition can hand an agent an RPC it can actually reach.
       *
       * Null when the worker is too old to report it. False is the state where
       * every agent scores exactly $0.00 regardless of what it would have
       * done, with nothing else on the page looking wrong.
       */
      readonly rpcRoutable: boolean | null;
    };

const TIMEOUT_MS = 4_000;
/**
 * The worker withholds per-queue detail without this, because a failure
 * message can carry the connection string that produced it.
 */
const TOKEN = process.env['BENCH_WORKER_HEALTH_TOKEN'];
/** A worker that streamed forever would otherwise hang a page render. */
const MAX_BYTES = 256 * 1024;

export async function workerHealth(): Promise<WorkerHealth> {
  const url = process.env['BENCH_WORKER_HEALTH_URL'];
  if (url === undefined || url.trim() === '') return { status: 'unconfigured' };

  try {
    // Short timeout and no caching: a status page showing a cached "up" is
    // worse than one saying it could not tell.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
      ...(TOKEN === undefined || TOKEN === ''
        ? {}
        : { headers: { authorization: `Bearer ${TOKEN}` } }),
    });
    if (!res.ok) return { status: 'unreachable', reason: `worker returned HTTP ${res.status}` };

    // Bounded read. Everything else that crosses a network boundary in Bench
    // has a byte cap; this had none because the far end is our own worker -
    // which is an argument about likelihood, not about what a page render
    // should be willing to buffer.
    const raw = await readCapped(res, MAX_BYTES);
    const body = JSON.parse(raw) as {
      status?: string;
      uptimeSeconds?: number;
      attention?: string[];
      detail?: string;
      capabilities?: { auditionRpcPubliclyRoutable?: boolean };
      queues?: Record<string, Omit<WorkerQueue, 'name'>>;
    };

    return {
      status: body.status === 'degraded' ? 'degraded' : 'up',
      uptimeSeconds: body.uptimeSeconds ?? 0,
      attention: body.attention ?? [],
      detailWithheld: body.detail === 'withheld',
      rpcRoutable: body.capabilities?.auditionRpcPubliclyRoutable ?? null,
      queues: Object.entries(body.queues ?? {})
        .map(([name, q]) => ({
          name,
          ticks: q.ticks ?? 0,
          failures: q.failures ?? 0,
          secondsSinceLastOk: q.secondsSinceLastOk ?? null,
          lastResult: q.lastResult ?? null,
          lastFailure: q.lastFailure ?? null,
          idleStreak: q.idleStreak ?? 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  } catch (err) {
    return {
      status: 'unreachable',
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Read a response body, refusing to buffer past `maxBytes`. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) return res.text();

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`worker health response exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}
