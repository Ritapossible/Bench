import type { AgentCategory, AgentId, AgentRecord, ProbeResult } from './agent.js';
import type { Bps, ChainName } from './primitives.js';

/**
 * Rolling liveness for one agent, folded from its probe history.
 *
 * Input to the "verified live" filter — the cheapest available fix for the
 * ~96%-dead-agent problem, and on its own it makes the catalog roughly 25×
 * denser in real agents than a raw registry read.
 */
export interface LivenessSummary {
  readonly agent: AgentId;
  readonly lastProbedAt: Date | null;
  /** Did the most recent probe reach the endpoint at all? */
  readonly reachable: boolean;
  /**
   * Did it speak the protocol it declares, or merely return 200? This is the
   * field that separates Bench from a registry read: plenty of endpoints
   * answer without implementing the protocol on their agent card.
   */
  readonly conformant: boolean;
  readonly uptimeBps: Bps;
  readonly p95LatencyMs: number | null;
  /** Probes behind this summary. One probe is not a track record. */
  readonly probeCount: number;
}

/**
 * Thresholds for "verified live". Deliberately constants rather than tunables
 * scattered across call sites: the filter is a claim Bench makes publicly, so
 * it has exactly one definition and the number is quotable in the docs.
 */
export const VERIFIED_LIVE = {
  /** A probe older than this says nothing about the agent *now*. */
  maxProbeAgeMs: 6 * 60 * 60 * 1000,
  /** Below this, the endpoint is flapping rather than live. */
  minUptimeBps: 8_000,
  /** Guards against calling a single lucky response a track record. */
  minProbeCount: 3,
} as const;

/**
 * The filter itself. Pure and total so it can be unit-tested and so the web
 * app, the worker, and the scorer cannot drift into three different notions of
 * what "live" means.
 *
 * Conformance is required, not just reachability — an endpoint that returns
 * 200 to everything is not a live agent, it is a live web server.
 */
export function isVerifiedLive(s: LivenessSummary, now: Date = new Date()): boolean {
  if (s.lastProbedAt === null) return false;
  if (!s.reachable || !s.conformant) return false;
  if (s.probeCount < VERIFIED_LIVE.minProbeCount) return false;
  if (now.getTime() - s.lastProbedAt.getTime() > VERIFIED_LIVE.maxProbeAgeMs) return false;
  return s.uptimeBps >= VERIFIED_LIVE.minUptimeBps;
}

const EMPTY = (agent: AgentId): LivenessSummary => ({
  agent,
  lastProbedAt: null,
  reachable: false,
  conformant: false,
  uptimeBps: 0,
  p95LatencyMs: null,
  probeCount: 0,
});

/**
 * Fold a probe history into a summary, per endpoint, and report the best one.
 *
 * This used to pool every probe an agent had into one bucket, and that was
 * wrong in two ways for any agent publishing more than one address.
 *
 * `conformant` was the latest probe's verdict, whichever endpoint it happened
 * to hit - so an agent with a working MCP service and a broken A2A card read
 * as conformant or not depending on which of the two was probed last. A coin
 * flip, re-tossed every few minutes.
 *
 * `uptimeBps` was the reachable fraction across the pooled set, so an agent
 * with one live endpoint and one dead one sat at about 50% - permanently below
 * the 80% floor `isVerifiedLive` requires. Such an agent could never be
 * verified live no matter how perfect its working service was, and nothing
 * said so: the catalog simply showed a low uptime for an endpoint that was
 * always up.
 *
 * An agent is as live as its best address, which is the same rule the audition
 * uses when it falls back from one transport to another, and the same rule the
 * triage script counts by. Three definitions of "live" that disagree is how
 * this project has produced every confident wrong number it has had to remove.
 *
 * `probeCount` is the winning endpoint's, not the total. Pooling it would let
 * three endpoints probed once each satisfy a rule that exists to stop one
 * lucky response being called a track record.
 */
export function summarizeProbes(agent: AgentId, probes: readonly ProbeResult[]): LivenessSummary {
  if (probes.length === 0) return EMPTY(agent);

  const byEndpoint = new Map<string, ProbeResult[]>();
  for (const p of probes) {
    const key = `${p.endpoint.protocol} ${p.endpoint.url}`;
    const bucket = byEndpoint.get(key);
    if (bucket === undefined) byEndpoint.set(key, [p]);
    else bucket.push(p);
  }

  const summaries = [...byEndpoint.values()].map((group) => summarizeOneEndpoint(agent, group));
  // Conformant beats reachable beats recent. Ties go to the endpoint probed
  // most recently, so a summary never goes stale while a live address exists.
  summaries.sort((a, b) => {
    if (a.conformant !== b.conformant) return a.conformant ? -1 : 1;
    if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
    if (a.uptimeBps !== b.uptimeBps) return b.uptimeBps - a.uptimeBps;
    return (b.lastProbedAt?.getTime() ?? 0) - (a.lastProbedAt?.getTime() ?? 0);
  });
  return summaries[0] ?? EMPTY(agent);
}

function summarizeOneEndpoint(agent: AgentId, probes: readonly ProbeResult[]): LivenessSummary {
  const sorted = [...probes].sort((a, b) => a.at.getTime() - b.at.getTime());
  // Non-null: callers only reach this with a non-empty group.
  const latest = sorted[sorted.length - 1]!;

  const reachableCount = sorted.filter((p) => p.reachable).length;
  const uptimeBps = Math.round((reachableCount / sorted.length) * 10_000);

  return {
    agent,
    lastProbedAt: latest.at,
    reachable: latest.reachable,
    conformant: latest.conformant,
    uptimeBps,
    p95LatencyMs: percentileLatency(sorted, 95),
    probeCount: sorted.length,
  };
}

/**
 * p95 over successful probes only. Including failures would let a fast-failing
 * endpoint report a better latency than a slow-but-working one.
 */
function percentileLatency(probes: readonly ProbeResult[], p: number): number | null {
  const latencies = probes
    .filter((x) => x.reachable && x.latencyMs !== null)
    .map((x) => x.latencyMs as number)
    .sort((a, b) => a - b);
  if (latencies.length === 0) return null;
  // Nearest-rank: the smallest value at or above the p-th percentile.
  const rank = Math.ceil((p / 100) * latencies.length);
  const idx = Math.min(Math.max(rank - 1, 0), latencies.length - 1);
  return latencies[idx]!;
}

export interface CatalogQuery {
  readonly chain?: ChainName;
  readonly category?: AgentCategory;
  /** The headline filter. Defaults to false so raw counts stay inspectable. */
  readonly verifiedLiveOnly?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface CatalogEntry {
  readonly record: AgentRecord;
  readonly liveness: LivenessSummary;
  readonly verifiedLive: boolean;
}

export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  readonly nextCursor: string | null;
}

/**
 * Catalog density, measured rather than asserted. Bench quotes the ~4% figure
 * from the ERC-8004 study; this is the same number computed against whatever
 * is actually indexed, so the claim on the page is our own data and can be
 * checked by anyone reading the catalog.
 */
export interface CatalogStats {
  readonly chain: ChainName;
  readonly registered: number;
  readonly withResolvableCard: number;
  readonly verifiedLive: number;
  readonly computedAt: Date;
}

export const liveShareBps = (s: CatalogStats): Bps =>
  s.registered === 0 ? 0 : Math.round((s.verifiedLive / s.registered) * 10_000);
