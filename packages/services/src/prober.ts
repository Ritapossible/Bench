import {
  VERIFIED_LIVE,
  type CatalogRepository,
  type ProbeClient,
  type ProbeResult,
} from '@bench/core';
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
  /**
   * How soon to re-probe an endpoint that does not yet have enough probes for
   * a verdict. See `bootstrapAfterMs` in DEFAULTS for why this is not the same
   * number as `staleAfterMs`.
   */
  readonly bootstrapAfterMs?: number;
  /**
   * How long to leave an endpoint that has never answered. See
   * `proberProfileFor`; omitted, every endpoint keeps the one cadence.
   */
  readonly coldAfterMs?: number;
}

export interface ProberTickResult {
  readonly probed: number;
  readonly reachable: number;
  readonly conformant: number;
  readonly failed: number;
  /**
   * Why the unreachable ones were unreachable, grouped by cause and ordered
   * most-common first.
   *
   * Added after a deployment probed two hundred endpoints, found none of them
   * reachable, and printed four numbers - none of which could distinguish an
   * environment with no outbound network from a policy filter rejecting every
   * address from a catalog that genuinely is dead. The reasons were being
   * recorded per agent in `probe_results.error` the whole time, which is the
   * right place for them and the wrong place to look when the question is
   * about the tick rather than about one agent.
   */
  readonly reasons: readonly (readonly [reason: string, count: number])[];
}

/**
 * Collapse a probe error into a cause that groups.
 *
 * Raw messages carry the URL, so two hundred failures for one reason arrive as
 * two hundred distinct strings and a tally of them says nothing. Stripping the
 * variable part is what turns the list into a diagnosis.
 */
export function classifyProbeError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('dns lookup timed out')) return 'DNS lookup timed out';
  if (m.includes('request timed out')) return 'request timed out';
  if (m.includes('timeout after')) return 'timeout';
  if (m.includes('resolves to blocked')) return 'blocked: resolves to a private address';
  if (m.includes('blocked address')) return 'blocked: literal private address';
  if (m.includes('blocked scheme')) return 'blocked: non-http scheme';
  if (m.includes('dns lookup failed') || m.includes('no addresses for')) return 'DNS lookup failed';
  if (m.includes('malformed url')) return 'malformed URL';
  if (m.includes('too many redirects')) return 'too many redirects';
  if (m.includes('econnrefused')) return 'connection refused';
  if (m.includes('enotfound')) return 'host not found';
  if (m.includes('certificate') || m.includes('cert_') || m.includes('self-signed')) {
    return 'TLS certificate rejected';
  }
  if (m.includes('econnreset') || m.includes('socket hang up')) return 'connection reset';
  if (m.includes('ehostunreach') || m.includes('enetunreach')) return 'network unreachable';
  // Anything unrecognised keeps a bounded slice of the original, so a cause we
  // have not seen before still reaches the log instead of becoming "other".
  return message.slice(0, 80);
}

const DEFAULTS = {
  batchSize: 200,
  /**
   * Raised from 16 once name resolution stopped being the bottleneck. Probes
   * are almost entirely waiting, so the limit exists to bound open sockets and
   * to keep Bench from looking like a burst of traffic to a stranger's host -
   * not to bound CPU.
   */
  concurrency: 32,
  staleAfterMs: 60 * 60 * 1000,
  /**
   * Two minutes, against an hour for the steady state.
   *
   * `isVerifiedLive` needs three probes. At the hourly cadence a fresh
   * deployment probed everything once in its first few minutes, went quiet for
   * an hour, and could not call any agent live for two hours - publishing "0%
   * of the registry is real" for the whole window, which is Bench reporting
   * its own cold start as a finding about the ecosystem. The hourly rule
   * exists to avoid hammering strangers' hosts; three probes two minutes apart
   * is still gentle, and it is the least that lets the number mean anything.
   */
  bootstrapAfterMs: 2 * 60 * 1000,
} as const;

/**
 * How often to ask, by how likely the endpoint is to answer.
 *
 * On BSC testnet every endpoint can be probed hourly and the whole set is
 * covered many times over. Mainnet is a different problem: about 36,000 of its
 * 343,000 registrations declare an endpoint, and measured against a random
 * sample, roughly 1,200 of those answer and speak their own protocol. Probing
 * all 36,000 hourly is 864,000 probes a day to learn nothing 97% of the time.
 *
 * The cost is not the real objection - the accuracy is. A prober that cannot
 * get round the set inside the freshness window drops agents out of "verified
 * live" because *Bench* did not reach them in time, and publishes that as a
 * fact about the agent. The number would measure this deployment's throughput
 * and be presented as a measurement of the ecosystem.
 *
 * So an endpoint with no reachable probe in its retained history is asked
 * every two days instead of every hour, and is promoted back the moment it
 * answers. The arithmetic that matters:
 *
 *   responders   ~1,200 hourly       = 28,800/day
 *   cold        ~35,000 two-daily    = 17,500/day
 *                                      ------------
 *                                      46,300/day, about 160 per five-minute
 *                                      tick, inside a batch of 200.
 *
 * Testnet keeps the single hourly cadence, where the set is small enough that
 * tiering would buy nothing and would only make the rule harder to state.
 */
export function proberProfileFor(chain: string): ProberOptions {
  return chain === 'bsc-mainnet' ? { coldAfterMs: 2 * 24 * 60 * 60 * 1000 } : {};
}

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
      {
        afterMs: this.opts.bootstrapAfterMs ?? DEFAULTS.bootstrapAfterMs,
        untilProbeCount: VERIFIED_LIVE.minProbeCount,
      },
      this.opts.coldAfterMs,
    );
    if (targets.length === 0) {
      return { probed: 0, reachable: 0, conformant: 0, failed: 0, reasons: [] };
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
    const causes = new Map<string, number>();
    const note = (message: string): void => {
      const cause = classifyProbeError(message);
      causes.set(cause, (causes.get(cause) ?? 0) + 1);
    };

    for (const s of settled) {
      if (!s.ok) {
        failed++;
        // A rejection here is the probe client or the database, not the
        // endpoint - it never reached a verdict, so it needs saying too.
        note(s.error instanceof Error ? `probe pipeline: ${s.error.message}` : 'probe pipeline');
        continue;
      }
      if (s.value.reachable) reachable++;
      else note(s.value.error ?? 'unreachable, no reason recorded');
      if (s.value.conformant) conformant++;
    }

    const reasons = [...causes.entries()].sort((a, b) => b[1] - a[1]);
    return { probed: settled.length - failed, reachable, conformant, failed, reasons };
  }
}
