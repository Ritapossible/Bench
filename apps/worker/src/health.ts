import { createServer, type Server } from 'node:http';

/**
 * Liveness for the worker.
 *
 * The worker is a set of timers, not a request handler, so it has no port of
 * its own and a host has no way to tell a process that is quietly wedged from
 * one that is working. This adds the smallest thing that answers that: a JSON
 * endpoint reporting when each queue last completed a tick.
 *
 * It reports and does not judge. Returning 503 when a queue looks stale sounds
 * stricter, and would be wrong here: the cadences differ by three orders of
 * magnitude - the indexer ticks every 30s, auditions hourly - so any single
 * staleness threshold either never fires or restarts a healthy worker in the
 * gap between two audition runs. A restart loop is worse than a slow queue,
 * and the ages are in the body for a human or an alert to read.
 */
export interface Heartbeat {
  mark(queue: string): void;
  fail(queue: string, reason?: string): void;
}

interface QueueState {
  lastOkAt: number | null;
  lastFailAt: number | null;
  ticks: number;
  failures: number;
  /**
   * Why the last failure failed.
   *
   * Counting failures says a queue is broken and nothing about what to do -
   * and on a hosted worker the logs are a click away from whoever is looking
   * at this endpoint, which in practice means the reason is not read. A queue
   * that has failed twice and cannot say why is a queue nobody can fix from
   * here.
   */
  lastFailReason: string | null;
}

export function startHealthServer(port: number): { heartbeat: Heartbeat; server: Server } {
  const startedAt = Date.now();
  const queues = new Map<string, QueueState>();
  const stateFor = (q: string): QueueState => {
    let s = queues.get(q);
    if (s === undefined) {
      s = { lastOkAt: null, lastFailAt: null, ticks: 0, failures: 0, lastFailReason: null };
      queues.set(q, s);
    }
    return s;
  };

  const heartbeat: Heartbeat = {
    mark(queue) {
      const s = stateFor(queue);
      s.lastOkAt = Date.now();
      s.ticks += 1;
    },
    fail(queue, reason) {
      const s = stateFor(queue);
      s.lastFailAt = Date.now();
      s.failures += 1;
      // Bounded: an error carrying a stack or a payload would otherwise put an
      // unbounded string in a public endpoint.
      s.lastFailReason = reason === undefined ? null : reason.slice(0, 300);
    },
  };

  const server = createServer((req, res) => {
    const now = Date.now();
    const body = {
      status: 'up',
      uptimeSeconds: Math.round((now - startedAt) / 1000),
      queues: Object.fromEntries(
        [...queues.entries()].map(([name, s]) => [
          name,
          {
            ticks: s.ticks,
            failures: s.failures,
            secondsSinceLastOk: s.lastOkAt === null ? null : Math.round((now - s.lastOkAt) / 1000),
            secondsSinceLastFailure:
              s.lastFailAt === null ? null : Math.round((now - s.lastFailAt) / 1000),
            lastFailure: s.lastFailReason,
          },
        ]),
      ),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
    // Nothing routes: every path answers the same thing, so a host that is
    // configured to check `/` and one configured to check `/health` both work.
    void req;
  });

  // A port already in use is a local-development annoyance, not a reason to
  // ground the worker - the queues are the product, this is instrumentation.
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[bench:worker] health server not listening (${err.code ?? err.message})`);
  });
  server.listen(port, () => {
    console.log(`[bench:worker] health on :${port}`);
  });
  // Do not let an idle health socket hold the process open during shutdown.
  server.unref();

  return { heartbeat, server };
}
