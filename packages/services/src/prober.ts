import type { CatalogRepository, ProbeClient, ProbeResult } from '@bench/core';
import { mapLimitSettled } from './concurrency.js';

/**
 * The prober: walk endpoints on a schedule, record reachability, latency, and
 * protocol conformance. This is what makes the "verified live" filter a
 * measurement rather than a claim.
 *
 * Scheduling is least-recently-probed-first, so a catalog larger than one
 * tick's capacity still cycles fairly instead of starving its tail — which
 * matters because the tail is where the dead agents are, and proving an agent
 * is dead is exactly as valuable as proving one is alive.
 */

export interface ProberOptions {
  /** Endpoints per tick. Bounds tick runtime and outbound socket count. */
  readonly batchSize?: number;
  readonly concurrency?: number;
  /** How stale a probe must be before the endpoint is due again. */
  readonly staleAfterMs?: number;
}

export interface ProberTickResult {
  readonly probed: number;
  readonly reachable: number;
  readonly conformant: number;
  readonly failed: number;
}

const DEFAULTS = {
  batchSize: 200,
  concurrency: 16,
  staleAfterMs: 60 * 60 * 1000,
} as const;

export class Prober {
  constructor(
    private readonly probes: ProbeClient,
    private readonly repo: CatalogRepository,
    private readonly opts: ProberOptions = {},
  ) {}

  async tick(): Promise<ProberTickResult> {
    const targets = await this.repo.dueForProbe(
      this.opts.batchSize ?? DEFAULTS.batchSize,
      this.opts.staleAfterMs ?? DEFAULTS.staleAfterMs,
    );
    if (targets.length === 0) {
      return { probed: 0, reachable: 0, conformant: 0, failed: 0 };
    }

    const settled = await mapLimitSettled(
      targets,
      this.opts.concurrency ?? DEFAULTS.concurrency,
      async (t): Promise<ProbeResult> => {
        // HttpProbeClient already turns transport failures into a
        // reachable:false result, so a rejection here means the probe client
        // itself broke — worth distinguishing from a dead endpoint.
        const result = await this.probes.probe(t.agent, t.endpoint);
        await this.repo.recordProbe(result);
        return result;
      },
    );

    let reachable = 0;
    let conformant = 0;
    let failed = 0;
    for (const s of settled) {
      if (!s.ok) {
        failed++;
        continue;
      }
      if (s.value.reachable) reachable++;
      if (s.value.conformant) conformant++;
    }

    return { probed: settled.length - failed, reachable, conformant, failed };
  }
}
