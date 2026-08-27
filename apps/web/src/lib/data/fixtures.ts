import {
  summarizeProbes,
  isVerifiedLive,
  type AgentCard,
  type AgentCategory,
  type AgentId,
  type AgentRecord,
  type CatalogStats,
  type OutcomeRecord,
  type ProbeResult,
  type AgreementSummary,
  type Score,
  type ShadowRun,
} from '@bench/core';
import type { AddressReportResult, AgentDetail, AgentSummary, BenchData } from './types';

/**
 * Fixtures.
 *
 * Shaped exactly like what the indexer, prober and shadow engine will return,
 * so that swapping in the real source is a change to `./index.ts` and nothing
 * else. Numbers here are illustrative and the UI labels them as such - see the
 * simulated/realized split, which fixtures honour like everything else.
 */

const CHAIN = 'bsc-testnet' as const;
/**
 * Real time, not a frozen instant.
 *
 * A fixed clock looked like the safer choice - deterministic pages, stable
 * screenshots - and it quietly made the fixtures dishonest. "Verified live"
 * means probed within six hours, and probes anchored to a fixed date stop
 * satisfying that the day after. The fixtures papered over it by passing the
 * same frozen clock into `isVerifiedLive`, so the front page kept claiming
 * agents were live off probes that were by then days old. The Postgres path
 * has no such option, which is how this surfaced: the seeded catalog reported
 * zero verified-live agents against a fixture page reporting twelve.
 *
 * Overclaiming liveness is the specific failure Bench exists to correct, so
 * the fixtures do not get to do it either.
 */
const now = () => new Date();

const id = (tokenId: number): AgentId => ({ chain: CHAIN, tokenId: BigInt(tokenId) });

export interface Seed {
  readonly tokenId: number;
  readonly name: string;
  readonly description: string;
  readonly category: AgentCategory;
  readonly live: boolean;
  readonly conformant: boolean;
  readonly probes: number;
  readonly uptimeBps: number;
  readonly p95: number;
  /** null = no completed auditions, which the UI must show rather than hide. */
  readonly deltaUsd: number | null;
  readonly sampleSize: number;
  readonly cardResolves: boolean;
}

export const SEEDS: readonly Seed[] = [
  // ---- rebalancing (judged) ----
  {
    tokenId: 1041,
    name: 'Kestrel LP Rebalancer',
    description:
      'Keeps a PancakeSwap v3 position inside its range, rebalancing on band breach with a cooldown.',
    category: 'rebalancing',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_940,
    p95: 210,
    deltaUsd: 341.22,
    sampleSize: 64,
    cardResolves: true,
  },
  {
    tokenId: 1102,
    name: 'Tideline Range Manager',
    description: 'Wide-band v3 manager. Fewer rebalances, lower fee burn, more range risk.',
    category: 'rebalancing',
    live: true,
    conformant: true,
    probes: 201,
    uptimeBps: 9_610,
    p95: 340,
    deltaUsd: 96.15,
    sampleSize: 43,
    cardResolves: true,
  },
  {
    tokenId: 1149,
    name: 'Meridian Auto-Range',
    description:
      'Volatility-scaled band width; widens the range as realized vol rises instead of rebalancing into it.',
    category: 'rebalancing',
    live: true,
    conformant: true,
    probes: 264,
    uptimeBps: 9_780,
    p95: 186,
    deltaUsd: 212.6,
    sampleSize: 37,
    cardResolves: true,
  },

  // ---- grid trading (judged) ----
  {
    tokenId: 1163,
    name: 'Hollow Grid v2',
    description: 'Grid trader on BNB/USDT. Aggressive step size, no trend filter.',
    category: 'grid',
    live: true,
    conformant: true,
    probes: 144,
    uptimeBps: 8_820,
    p95: 512,
    deltaUsd: -212.68,
    sampleSize: 38,
    cardResolves: true,
  },
  {
    tokenId: 1171,
    name: 'Latch Grid',
    description: 'Grid with a trend filter that suspends the ladder when the range breaks.',
    category: 'grid',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_720,
    p95: 240,
    deltaUsd: 158.04,
    sampleSize: 52,
    cardResolves: true,
  },
  {
    tokenId: 1185,
    name: 'Shoal DCA Grid',
    description: 'Wide, slow grid sized for accumulation rather than scalping.',
    category: 'grid',
    live: true,
    conformant: true,
    probes: 240,
    uptimeBps: 9_450,
    p95: 298,
    deltaUsd: 41.9,
    sampleSize: 29,
    cardResolves: true,
  },

  // ---- yield optimization (judged) ----
  {
    tokenId: 1190,
    name: 'Marlin Yield Router',
    description: 'Rotates stables between Venus and Alpaca on rate spread, net of gas.',
    category: 'yield',
    live: true,
    conformant: true,
    probes: 96,
    uptimeBps: 9_320,
    p95: 288,
    deltaUsd: 54.9,
    sampleSize: 17,
    cardResolves: true,
  },
  {
    tokenId: 1196,
    name: 'Cinder Vault Optimizer',
    description: 'Compounds vault rewards on a gas-aware schedule instead of a fixed interval.',
    category: 'yield',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_890,
    p95: 174,
    deltaUsd: 187.35,
    sampleSize: 48,
    cardResolves: true,
  },
  {
    tokenId: 1199,
    name: 'Drift Stable Allocator',
    description: 'Splits stables across three lenders by marginal rate, capped per venue.',
    category: 'yield',
    live: true,
    conformant: true,
    probes: 216,
    uptimeBps: 9_540,
    p95: 262,
    deltaUsd: 73.11,
    sampleSize: 24,
    cardResolves: true,
  },

  // ---- health factor monitoring (judged) ----
  {
    tokenId: 1077,
    name: 'Venus Sentinel',
    description:
      'Watches Venus health factor and unwinds a slice of the loan before the liquidation price is touched.',
    category: 'health-factor',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_985,
    p95: 128,
    deltaUsd: 288.4,
    sampleSize: 51,
    cardResolves: true,
  },
  {
    tokenId: 1204,
    name: 'Northgate Liquidation Guard',
    description: 'Health-factor alerting with a naive fixed threshold. Alerts only; never acts.',
    category: 'health-factor',
    live: true,
    conformant: true,
    probes: 72,
    uptimeBps: 9_100,
    p95: 402,
    deltaUsd: 12.4,
    sampleSize: 11,
    cardResolves: true,
  },
  {
    tokenId: 1212,
    name: 'Bulwark HF Autopilot',
    description:
      'Repays from a stable buffer when the health factor crosses a moving floor derived from collateral volatility.',
    category: 'health-factor',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_920,
    p95: 143,
    deltaUsd: 244.75,
    sampleSize: 41,
    cardResolves: true,
  },

  // ---- extras: listed and probed, ranked on liveness only ----
  {
    tokenId: 1118,
    name: 'Aegis Swap Router',
    description: 'Slippage-, MEV- and honeypot-guarded routing across PancakeSwap and 1inch.',
    category: 'other',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_899,
    p95: 96,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: true,
  },
  {
    tokenId: 1221,
    name: 'Cobalt Monitor',
    description: 'Event monitoring for treasury multisigs.',
    category: 'monitoring',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 9_760,
    p95: 155,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: true,
  },

  // ---- the ~96% the verified-live filter exists to remove ----
  // Responds, but does not speak the protocol on its card - the distinction
  // that separates Bench's filter from a registry read.
  {
    tokenId: 1240,
    name: 'AlphaVault Optimizer',
    description: 'Declares A2A; the endpoint returns 200 to everything and implements none of it.',
    category: 'yield',
    live: true,
    conformant: false,
    probes: 60,
    uptimeBps: 9_990,
    p95: 44,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: true,
  },
  {
    tokenId: 1256,
    name: 'Quantum Yield Maximizer',
    description: 'Endpoint has not answered since registration.',
    category: 'yield',
    live: false,
    conformant: false,
    probes: 288,
    uptimeBps: 0,
    p95: 0,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: true,
  },
  {
    tokenId: 1288,
    name: 'unresolved',
    description: '',
    category: 'other',
    live: false,
    conformant: false,
    probes: 12,
    uptimeBps: 0,
    p95: 0,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: false,
  },
  {
    tokenId: 1301,
    name: 'Ember Rebalancer',
    description: 'Flapping endpoint - reachable under half the time.',
    category: 'rebalancing',
    live: true,
    conformant: true,
    probes: 288,
    uptimeBps: 4_400,
    p95: 1_820,
    deltaUsd: null,
    sampleSize: 0,
    cardResolves: true,
  },
];

function card(s: Seed): AgentCard | null {
  if (!s.cardResolves) return null;
  return {
    name: s.name,
    description: s.description,
    category: s.category,
    endpoints: [{ protocol: 'a2a', url: `https://agents.example/${s.tokenId}/a2a` }],
    permissions: { contractAllowlist: [], requiresTokenApprovals: true },
    raw: {},
  };
}

export function record(s: Seed): AgentRecord {
  return {
    id: id(s.tokenId),
    owner: `0x${s.tokenId.toString(16).padStart(40, 'a')}` as `0x${string}`,
    cardUri: `ipfs://bafy${s.tokenId}`,
    card: card(s),
    ...(s.cardResolves ? {} : { cardError: 'tokenURI returned 404' }),
    registeredAt: new Date('2026-07-02T09:00:00Z'),
  };
}

/** Synthesise a probe history matching the seed's uptime and conformance. */
export function probes(s: Seed, anchor: Date = now()): ProbeResult[] {
  const agent = id(s.tokenId);
  const endpoint = { protocol: 'a2a' as const, url: `https://agents.example/${s.tokenId}/a2a` };
  const reachableCount = Math.round((s.uptimeBps / 10_000) * s.probes);
  const failures = s.probes - reachableCount;
  // Spread failures evenly through the history rather than bunching them at
  // one end. Bunching them last makes the newest probe a failure for every
  // agent below 100% uptime, which silently fails isVerifiedLive's
  // `latest.reachable` check - the catalog then shows one agent instead of
  // eight, and looks like a filter bug rather than a fixture bug.
  const failEvery = failures > 0 ? s.probes / failures : Number.POSITIVE_INFINITY;
  return Array.from({ length: s.probes }, (_, i) => {
    const isLast = i === s.probes - 1;
    const reachable =
      s.uptimeBps === 0 ? false : isLast ? true : Math.floor(i % failEvery) !== 0 || i === 0;
    return {
      agent,
      endpoint,
      at: new Date(anchor.getTime() - (s.probes - i) * 5 * 60 * 1000),
      reachable,
      latencyMs: reachable ? s.p95 : null,
      conformant: reachable && s.conformant,
    };
  });
}

export function score(s: Seed): Score | null {
  if (s.deltaUsd === null || s.sampleSize === 0) return null;
  const metric =
    s.category === 'rebalancing'
      ? ({
          kind: 'rebalancing',
          inRangeBps: 8_400 + Math.round(s.deltaUsd / 4),
          rebalanceCount: 6,
          feesEarnedUsd: Math.max(0, s.deltaUsd),
        } as const)
      : s.category === 'health-factor'
        ? ({
            kind: 'health-factor',
            medianLeadTimeSec: 1_840,
            missedEvents: 0,
            falseAlarmRate: 0.04,
          } as const)
        : s.category === 'grid'
          ? ({
              kind: 'grid',
              realizedPnlUsd: s.deltaUsd,
              maxDrawdownUsd: 412,
              fillQualityBps: 6,
            } as const)
          : s.category === 'monitoring'
            ? ({ kind: 'monitoring', precision: 0.91, recall: 0.86, falseAlarmRate: 0.09 } as const)
            : ({
                kind: 'yield',
                riskAdjustedReturnBps: Math.round(s.deltaUsd * 1.4),
                maxDrawdownUsd: 180,
              } as const);

  return {
    agent: id(s.tokenId),
    category: s.category,
    basis: 'simulated',
    window: { start: new Date('2026-07-25T00:00:00Z'), end: now() },
    sampleSize: s.sampleSize,
    baseline: { kind: 'do-nothing' },
    normalized: Math.max(0, Math.min(1, 0.5 + s.deltaUsd / 800)),
    metric,
  };
}

function summary(s: Seed): AgentSummary {
  const liveness = summarizeProbes(id(s.tokenId), probes(s));
  return {
    entry: { record: record(s), liveness, verifiedLive: isVerifiedLive(liveness) },
    score: score(s),
  };
}

const ALL: readonly AgentSummary[] = SEEDS.map(summary);

const statsAt = (daysAgo: number): CatalogStats => ({
  chain: CHAIN,
  registered: 312 - daysAgo * 3,
  withResolvableCard: 168 - daysAgo * 2,
  verifiedLive: Math.max(0, 27 - Math.round(daysAgo * 0.7)),
  computedAt: new Date(now().getTime() - daysAgo * 86_400_000),
});

export const fixtureData: BenchData = {
  async catalogStats() {
    return statsAt(0);
  },

  async catalogHistory() {
    return Array.from({ length: 21 }, (_, i) => statsAt(20 - i));
  },

  async catalogProvenance() {
    return 'fixtures' as const;
  },

  async crossReference(): Promise<AgreementSummary> {
    // Honest default: no 8004scan key is configured yet, so nothing has been
    // corroborated. This lights up on its own once the key is in the
    // environment - see buildCrossReference in @bench/adapters.
    return {
      source: '8004scan',
      status: 'unconfigured',
      checked: 0,
      confirmed: 0,
      notFound: 0,
      agreementBps: 0,
    };
  },

  async listAgents(opts) {
    let out = ALL;
    if (opts?.verifiedLiveOnly) out = out.filter((a) => a.entry.verifiedLive);
    if (opts?.category) out = out.filter((a) => a.entry.record.card?.category === opts.category);
    return [...out].sort((a, b) => (b.score?.normalized ?? -1) - (a.score?.normalized ?? -1));
  },

  async getAgent(chain, tokenId): Promise<AgentDetail | null> {
    const found = ALL.find(
      (a) => a.entry.record.id.chain === chain && a.entry.record.id.tokenId.toString() === tokenId,
    );
    if (!found) return null;

    const runs: ShadowRun[] = found.score
      ? Array.from({ length: 3 }, (_, i) => ({
          id: `run_${tokenId}_${i}`,
          agent: found.entry.record.id,
          window: {
            id: ['crash-0725', 'chop-0801', 'rally-0812'][i]!,
            label: ['Crash - 25 Jul', 'Chop - 1 Aug', 'Rally - 12 Aug'][i]!,
            regime: (['crash', 'chop', 'rally'] as const)[i]!,
            forkBlock: BigInt(48_120_000 + i * 40_000),
            endBlock: BigInt(48_140_000 + i * 40_000),
            seed: `0x${(i + 1).toString(16).repeat(8)}`,
          },
          position: {
            kind: found.entry.record.card?.category === 'health-factor' ? 'venus-loan' : 'pcs-lp',
            label:
              found.entry.record.card?.category === 'health-factor'
                ? 'Venus USDT loan, HF 1.32'
                : found.entry.record.card?.category === 'grid'
                  ? 'BNB/USDT spot ladder'
                  : 'PCS v3 BNB/USDT 0.05%',
            params: {},
            capital: {
              token: '0x55d398326f99059ff775485246999027b3197955',
              symbol: 'USDT',
              decimals: 18,
              amount: 10_000n * 10n ** 18n,
            },
          },
          status: 'complete',
          startedAt: new Date(now().getTime() - (3 - i) * 86_400_000),
          finishedAt: new Date(now().getTime() - (3 - i) * 86_400_000 + 3_600_000),
          egressSpentUsd: 0.42,
        }))
      : [];

    const outcomes: OutcomeRecord[] = runs.map((r, i) => ({
      runId: r.id,
      terminal: {
        valueUsd: 10_000 + (found.score ? (found.score.normalized - 0.5) * 800 * (i + 1) * 0.4 : 0),
        detail: {},
      },
      deltaVsDoNothingUsd: found.score ? ((found.score.normalized - 0.5) * 800) / (i + 1) : 0,
      deltaVsPeerMedianUsd: found.score ? ((found.score.normalized - 0.5) * 300) / (i + 1) : null,
      maxDrawdownUsd: 180 + i * 40,
      actionCount: 4 + i * 3,
    }));

    return { ...found, runs, outcomes, realized: null };
  },

  async reportForAddress(address): Promise<AddressReportResult> {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return { status: 'invalid-address' };
    const ranked = ALL.filter((a) => a.entry.verifiedLive && a.score !== null);
    return {
      status: 'ok',
      report: {
        address,
        positionLabel: 'PancakeSwap v3 · BNB/USDT 0.05% · in range',
        positionValueUsd: 12_480.55,
        windowLabel: '25 Jul - 25 Aug 2026',
        doNothingUsd: 12_480.55,
        lines: ranked.map((a) => ({
          agent: a.entry.record.id,
          name: a.entry.record.card?.name ?? 'unresolved',
          category: a.entry.record.card?.category ?? 'other',
          deltaUsd: ((a.score!.normalized - 0.5) * 800 * 12_480.55) / 10_000,
          actionCount: 4 + Math.round(a.score!.sampleSize / 8),
          verifiedLive: a.entry.verifiedLive,
        })),
        computedAt: now(),
      },
    };
  },
};
