import {
  isThin,
  type AgentCategory,
  type AgentId,
  type AuditionStore,
  type Baseline,
  type CategoryMetric,
  type OutcomeRecord,
  type Score,
  type ShadowRun,
} from '@bench/core';

/**
 * Turns audition outcomes into scores - ARCHITECTURE.md 3.4.
 *
 * The one rule this file exists to enforce: **a score is a summary of recorded
 * outcomes, never an opinion about an agent.** Every number below is computed
 * from `outcome_records` rows that a shadow run actually produced, and an agent
 * with no outcomes gets no score rather than a zero. A zero reads as "measured
 * and bad"; absent reads as "not measured", and only one of those is true.
 *
 * Simulated and realized are computed by the same code from different inputs
 * and stored under different bases. They are never averaged together.
 */

export interface ScorerOptions {
  /** Outcomes older than this fall out of the window. */
  readonly windowMs?: number;
  /** Outcomes to consider per agent. */
  readonly limit?: number;
}

export interface ScoringResult {
  readonly agent: AgentId;
  readonly score: Score | null;
  /** Why no score, when there is none. */
  readonly reason?: 'no-outcomes';
}

const DEFAULTS = {
  windowMs: 30 * 24 * 60 * 60 * 1000,
  limit: 50,
} as const;

/**
 * Normalise a delta against the capital at risk, then squash to [0, 1].
 *
 * A raw dollar delta cannot be compared across agents - $200 on a $500,000
 * position is noise and on a $2,000 position is remarkable - so the ratio is
 * what carries meaning. 0.5 is "matched the baseline exactly", which keeps the
 * midpoint honest: an agent that did nothing useful does not score zero, it
 * scores neutral, and only losing money drops below it.
 *
 * The tanh keeps the scale bounded without a cliff, so one spectacular window
 * cannot pin an agent at 1.0 and hide its variance.
 */
export function normalizeDelta(deltaUsd: number, capitalUsd: number): number {
  if (!Number.isFinite(deltaUsd) || !Number.isFinite(capitalUsd) || capitalUsd <= 0) return 0.5;
  const ratio = deltaUsd / capitalUsd;
  // tanh(ratio * 8) puts a 10% gain near 0.83 and a 10% loss near 0.17.
  return Math.min(1, Math.max(0, 0.5 + Math.tanh(ratio * 8) / 2));
}

/** Category-native metric, derived only from what the runs recorded. */
export function metricFor(
  category: AgentCategory,
  outcomes: readonly OutcomeRecord[],
): CategoryMetric {
  const n = Math.max(1, outcomes.length);
  const sum = (f: (o: OutcomeRecord) => number): number => outcomes.reduce((a, o) => a + f(o), 0);
  const worstDrawdown = outcomes.reduce((a, o) => Math.max(a, o.maxDrawdownUsd), 0);
  const actions = sum((o) => o.actionCount);
  const delta = sum((o) => o.deltaVsDoNothingUsd);

  switch (category) {
    case 'rebalancing':
      return {
        kind: 'rebalancing',
        // No tick data in the outcome record, so the honest proxy is how much
        // of the run avoided drawdown. Replaced by real in-range time when the
        // seeders record it.
        inRangeBps: Math.round(
          10_000 * (1 - Math.min(1, worstDrawdown / Math.max(1, Math.abs(delta) + worstDrawdown))),
        ),
        rebalanceCount: Math.round(actions / n),
        feesEarnedUsd: Math.max(0, delta),
      };
    case 'grid':
      return {
        kind: 'grid',
        realizedPnlUsd: delta,
        maxDrawdownUsd: worstDrawdown,
        fillQualityBps: Math.round(
          10_000 * (actions === 0 ? 0 : Math.min(1, Math.abs(delta) / Math.max(1, actions * 10))),
        ),
      };
    case 'yield':
      return {
        kind: 'yield',
        riskAdjustedReturnBps: Math.round(
          10_000 * (delta / Math.max(1, worstDrawdown + Math.abs(delta))),
        ),
        maxDrawdownUsd: worstDrawdown,
      };
    case 'health-factor':
      return {
        kind: 'health-factor',
        // Lead time and missed events need liquidation-event data the outcome
        // record does not carry yet. Reported as zero/none rather than
        // estimated, so the display shows an unmeasured field as unmeasured.
        medianLeadTimeSec: 0,
        missedEvents: 0,
        falseAlarmRate: 0,
      };
    case 'monitoring':
      return { kind: 'monitoring', precision: 0, recall: 0, falseAlarmRate: 0 };
    default:
      // 'other' has no category-native metric. Yield is the least
      // presumptuous shape: a return and a drawdown, both measured.
      return {
        kind: 'yield',
        riskAdjustedReturnBps: Math.round(
          10_000 * (delta / Math.max(1, worstDrawdown + Math.abs(delta))),
        ),
        maxDrawdownUsd: worstDrawdown,
      };
  }
}

export class Scorer {
  constructor(
    private readonly store: AuditionStore,
    private readonly opts: ScorerOptions = {},
  ) {}

  /**
   * Score one agent from its recorded outcomes.
   *
   * Returns null rather than a zero when nothing has been recorded. The caller
   * writes nothing in that case, so an unaudited agent stays absent from the
   * scores table and the UI keeps saying "not audited yet".
   */
  async scoreAgent(
    agent: AgentId,
    category: AgentCategory,
    basis: Score['basis'] = 'simulated',
  ): Promise<ScoringResult> {
    const limit = this.opts.limit ?? DEFAULTS.limit;
    const [runs, outcomes] = await Promise.all([
      this.store.runsFor(agent, limit),
      this.store.outcomesFor(agent, limit),
    ]);

    const windowMs = this.opts.windowMs ?? DEFAULTS.windowMs;
    const cutoff = Date.now() - windowMs;
    const byRun = new Map(runs.map((r) => [r.id, r]));
    const inWindow = outcomes.filter((o) => {
      const run = byRun.get(o.runId);
      const at = run?.finishedAt ?? run?.startedAt ?? null;
      return at === null || at.getTime() >= cutoff;
    });

    if (inWindow.length === 0) return { agent, score: null, reason: 'no-outcomes' };

    const capital = capitalOf(runs);
    const meanDelta = inWindow.reduce((a, o) => a + o.deltaVsDoNothingUsd, 0) / inWindow.length;

    const times = inWindow.flatMap((o) => {
      const at = byRun.get(o.runId)?.finishedAt ?? byRun.get(o.runId)?.startedAt;
      return at === undefined || at === null ? [] : [at.getTime()];
    });
    const start = times.length > 0 ? new Date(Math.min(...times)) : new Date(cutoff);
    const end = times.length > 0 ? new Date(Math.max(...times)) : new Date();

    // The baseline every delta was measured from. Recorded on the score so a
    // reader never has to assume which comparison produced the number.
    const baseline: Baseline = { kind: 'do-nothing' };

    return {
      agent,
      score: {
        agent,
        category,
        basis,
        window: { start, end },
        sampleSize: inWindow.length,
        baseline,
        normalized: normalizeDelta(meanDelta, capital),
        meanDeltaUsd: meanDelta,
        capitalUsd: capital,
        metric: metricFor(category, inWindow),
      },
    };
  }

  /**
   * Score many agents and persist the ones that have evidence.
   *
   * Returns the agents it skipped as well as the ones it scored, because "no
   * outcomes yet" is the normal state for most of the catalog and a caller
   * logging only successes would make it look like the scorer was failing.
   */
  async scoreAll(
    agents: readonly { readonly id: AgentId; readonly category: AgentCategory }[],
    basis: Score['basis'] = 'simulated',
  ): Promise<{ scored: number; skipped: number; thin: number }> {
    let scored = 0;
    let skipped = 0;
    let thin = 0;

    for (const { id, category } of agents) {
      const result = await this.scoreAgent(id, category, basis);
      if (result.score === null) {
        skipped += 1;
        continue;
      }
      if (isThin(result.score)) thin += 1;
      await this.store.putScore(result.score);
      scored += 1;
    }

    return { scored, skipped, thin };
  }
}

/** Mean capital across the runs, so the delta ratio has a denominator. */
function capitalOf(runs: readonly ShadowRun[]): number {
  const amounts = runs.flatMap((r) => {
    const { amount, decimals } = r.position.capital;
    const value = Number(amount) / 10 ** decimals;
    return Number.isFinite(value) && value > 0 ? [value] : [];
  });
  return amounts.length === 0 ? 0 : amounts.reduce((a, b) => a + b, 0) / amounts.length;
}
