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
    };

const TIMEOUT_MS = 4_000;

export async function workerHealth(): Promise<WorkerHealth> {
  const url = process.env['BENCH_WORKER_HEALTH_URL'];
  if (url === undefined || url.trim() === '') return { status: 'unconfigured' };

  try {
    // Short timeout and no caching: a status page showing a cached "up" is
    // worse than one saying it could not tell.
    const res = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!res.ok) return { status: 'unreachable', reason: `worker returned HTTP ${res.status}` };

    const body = (await res.json()) as {
      status?: string;
      uptimeSeconds?: number;
      attention?: string[];
      queues?: Record<string, Omit<WorkerQueue, 'name'>>;
    };

    return {
      status: body.status === 'degraded' ? 'degraded' : 'up',
      uptimeSeconds: body.uptimeSeconds ?? 0,
      attention: body.attention ?? [],
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
