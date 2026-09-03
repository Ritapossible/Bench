import { describe, expect, it } from 'vitest';
import type {
  AgentId,
  AuditionStore,
  CatalogStats,
  OutcomeRecord,
  Score,
  ShadowRun,
} from '@bench/core';
import { Scorer, metricFor, normalizeDelta } from '../src/scorer.js';

const AGENT: AgentId = { chain: 'bsc-testnet', tokenId: 7n };
const USDT = '0x55d398326f99059ff775485246999027b3197955' as const;

const run = (id: string, at: Date, capitalWhole: bigint): ShadowRun => ({
  id,
  agent: AGENT,
  window: {
    id: 'w',
    label: 'w',
    regime: 'live',
    forkBlock: 1n,
    endBlock: 2n,
    seed: 's',
  },
  position: {
    kind: 'spot-balance',
    label: 'p',
    params: {},
    capital: { token: USDT, symbol: 'USDT', decimals: 18, amount: capitalWhole * 10n ** 18n },
  },
  status: 'complete',
  startedAt: at,
  finishedAt: at,
  egressSpentUsd: 0,
  gasSpentUsd: 0,
});

const outcome = (runId: string, delta: number): OutcomeRecord => ({
  runId,
  terminal: { valueUsd: 10_000 + delta, detail: {} },
  deltaVsDoNothingUsd: delta,
  deltaVsPeerMedianUsd: null,
  maxDrawdownUsd: Math.max(0, -delta),
  actionCount: 4,
});

/** Only what the scorer touches. */
class StubStore implements Partial<AuditionStore> {
  readonly written: Score[] = [];
  constructor(
    private readonly runs: readonly ShadowRun[] = [],
    private readonly outcomes: readonly OutcomeRecord[] = [],
  ) {}
  async runsFor(): Promise<readonly ShadowRun[]> {
    return this.runs;
  }
  async outcomesFor(): Promise<readonly OutcomeRecord[]> {
    return this.outcomes;
  }
  readonly deleted: AgentId[] = [];
  /** Pretend a score is on file for every agent, so retraction is observable. */
  scoresOnFile = 1;
  async putScore(s: Score): Promise<void> {
    this.written.push(s);
  }
  async deleteScores(agent: AgentId): Promise<number> {
    this.deleted.push(agent);
    return this.scoresOnFile;
  }
  async recordStats(_s: CatalogStats): Promise<void> {}
}

const build = (store: StubStore) => new Scorer(store as unknown as AuditionStore);

describe('normalizeDelta', () => {
  it('puts "matched the baseline" at the midpoint, not at zero', () => {
    // An agent that neither helped nor hurt is neutral. Scoring it zero would
    // rank it alongside one that lost the whole position.
    expect(normalizeDelta(0, 10_000)).toBe(0.5);
  });

  it('is monotonic and bounded', () => {
    expect(normalizeDelta(500, 10_000)).toBeGreaterThan(normalizeDelta(100, 10_000));
    expect(normalizeDelta(-500, 10_000)).toBeLessThan(0.5);
    expect(normalizeDelta(1e9, 10_000)).toBeLessThanOrEqual(1);
    expect(normalizeDelta(-1e9, 10_000)).toBeGreaterThanOrEqual(0);
  });

  it('scores by ratio, so the same dollars mean different things at different sizes', () => {
    // $200 on $2,000 is remarkable; on $500,000 it is noise. A raw dollar
    // delta would rank them identically.
    expect(normalizeDelta(200, 2_000)).toBeGreaterThan(normalizeDelta(200, 500_000));
  });

  it('refuses to divide by a capital it does not have', () => {
    expect(normalizeDelta(100, 0)).toBe(0.5);
    expect(normalizeDelta(Number.NaN, 10_000)).toBe(0.5);
  });
});

describe('metricFor', () => {
  it('produces the category-native shape', () => {
    expect(metricFor('rebalancing', [outcome('r', 100)]).kind).toBe('rebalancing');
    expect(metricFor('grid', [outcome('r', 100)]).kind).toBe('grid');
    expect(metricFor('yield', [outcome('r', 100)]).kind).toBe('yield');
    expect(metricFor('health-factor', [outcome('r', 100)]).kind).toBe('health-factor');
    expect(metricFor('monitoring', [outcome('r', 100)]).kind).toBe('monitoring');
  });

  it('reports unmeasured fields as zero rather than estimating them', () => {
    // Lead time needs liquidation-event data the outcome record does not carry.
    // Inventing a plausible number would be worse than reporting none.
    const m = metricFor('health-factor', [outcome('r', 100)]);
    if (m.kind !== 'health-factor') throw new Error('wrong shape');
    expect(m.medianLeadTimeSec).toBe(0);
    expect(m.missedEvents).toBe(0);
  });
});

describe('Scorer', () => {
  it('gives an agent with no outcomes no score at all', async () => {
    // Not a zero. Zero reads as "measured and bad"; absent reads as "not
    // measured", and only one of those is true.
    const store = new StubStore([], []);
    const result = await build(store).scoreAgent(AGENT, 'yield');

    expect(result.score).toBeNull();
    expect(result.reason).toBe('no-outcomes');
    expect(store.written).toHaveLength(0);
  });

  it('scores from recorded outcomes and reports its sample size', async () => {
    const at = new Date();
    const store = new StubStore(
      [run('r1', at, 10_000n), run('r2', at, 10_000n)],
      [outcome('r1', 400), outcome('r2', 600)],
    );

    const { score } = await build(store).scoreAgent(AGENT, 'yield');

    expect(score?.sampleSize).toBe(2);
    expect(score?.basis).toBe('simulated');
    expect(score?.baseline).toEqual({ kind: 'do-nothing' });
    // Mean +500 on 10,000 capital: above neutral, well short of the ceiling.
    expect(score?.normalized).toBeGreaterThan(0.5);
    expect(score?.normalized).toBeLessThan(1);
  });

  it('records the dollars it measured, not a number recoverable from the score', async () => {
    // `normalized` is a bounded tanh of delta-over-capital, so it cannot be
    // inverted back to dollars. Three pages nonetheless rendered
    // `(normalized - 0.5) * 800` under the caption "vs doing nothing": here
    // that would have shown $174.68 for a $500 result. The measured figures
    // have to travel on the score itself.
    const at = new Date();
    const store = new StubStore(
      [run('r1', at, 10_000n), run('r2', at, 10_000n)],
      [outcome('r1', 400), outcome('r2', 600)],
    );

    const { score } = await build(store).scoreAgent(AGENT, 'yield');

    expect(score?.meanDeltaUsd).toBe(500);
    expect(score?.capitalUsd).toBe(10_000);
    // The old reconstruction, kept here so the gap stays visible if anyone
    // reaches for it again.
    expect((score!.normalized - 0.5) * 800).not.toBeCloseTo(500, 0);
  });

  it('keeps the delta signed, so a loss reads as a loss in dollars too', async () => {
    const at = new Date();
    const store = new StubStore([run('r1', at, 10_000n)], [outcome('r1', -800)]);
    const { score } = await build(store).scoreAgent(AGENT, 'yield');
    expect(score?.meanDeltaUsd).toBe(-800);
  });

  it('scores a losing agent below neutral', async () => {
    const at = new Date();
    const store = new StubStore([run('r1', at, 10_000n)], [outcome('r1', -800)]);
    const { score } = await build(store).scoreAgent(AGENT, 'yield');
    expect(score?.normalized).toBeLessThan(0.5);
  });

  it('drops outcomes whose run fell outside the window', async () => {
    const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const store = new StubStore([run('r1', old, 10_000n)], [outcome('r1', 400)]);
    const { score } = await build(store).scoreAgent(AGENT, 'yield');
    expect(score).toBeNull();
  });

  it('persists only the agents that had evidence', async () => {
    const at = new Date();
    const store = new StubStore([run('r1', at, 10_000n)], [outcome('r1', 400)]);
    const r = await build(store).scoreAll([{ id: AGENT, category: 'yield' }]);

    expect(r.scored).toBe(1);
    expect(store.written).toHaveLength(1);
    // One run is not a track record, and the caller is told so.
    expect(r.thin).toBe(1);
  });

  it('withdraws a score once the evidence behind it stops counting', async () => {
    // Excluding auditions that failed left twenty agents with no evidence and
    // a published score still on file. The scorer skipped them on every pass
    // and the catalog went on showing a number it would no longer produce -
    // re-running could not fix it, because nothing ever removed a row.
    const store = new StubStore([], []);
    const r = await build(store).scoreAll([{ id: AGENT, category: 'yield' }]);

    expect(r.scored).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.retracted).toBe(1);
    expect(store.deleted).toEqual([AGENT]);
    expect(store.written).toHaveLength(0);
  });

  it('does not touch the score of an agent that still has evidence', async () => {
    const at = new Date();
    const store = new StubStore([run('r1', at, 10_000n)], [outcome('r1', 400)]);
    const r = await build(store).scoreAll([{ id: AGENT, category: 'yield' }]);

    expect(r.retracted).toBe(0);
    expect(store.deleted).toEqual([]);
  });

  it('never merges realized into simulated', async () => {
    const at = new Date();
    const store = new StubStore([run('r1', at, 10_000n)], [outcome('r1', 400)]);
    const { score } = await build(store).scoreAgent(AGENT, 'yield', 'realized');
    expect(score?.basis).toBe('realized');
  });
});
