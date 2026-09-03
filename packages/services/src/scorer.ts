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
    case 'rebalancing': {
      /**
       * Measured from the LP position, now that one can be seeded.
       *
       * `inRangeBps` was `1 - drawdown/(|delta|+drawdown)` scaled to basis
       * points - real arithmetic over real inputs, and not time in range,
       * because a spot balance has no range to be in. It is now the share of
       * runs that ended with liquidity still deployed, which is what the
       * position records and what a rebalancing agent is paid to maintain.
       *
       * Runs against a position that carries no LP detail contribute nothing
       * rather than a zero, so a catalog auditioned before the seeder existed
       * does not drag the number down.
       */
      const lpRuns = outcomes.filter((o) => typeof o.terminal.detail['positions'] === 'number');
      const active = lpRuns.filter((o) => (o.terminal.detail['activePositions'] ?? 0) > 0).length;
      return {
        kind: 'rebalancing',
        inRangeBps: lpRuns.length === 0 ? 0 : Math.round((10_000 * active) / lpRuns.length),
        rebalanceCount: Math.round(actions / n),
        /** Fees need the position's collected amounts, which are not recorded yet. */
        feesEarnedUsd: 0,
      };
    }
    case 'grid':
      return {
        kind: 'grid',
        realizedPnlUsd: delta,
        maxDrawdownUsd: worstDrawdown,
        /**
         * Zero rather than `|delta| / (actions * 10)`, which measured dollars
         * per action against an arbitrary $10 and was reported as execution
         * quality. Fill quality needs the price each order filled at against
         * the price it was placed at, and the outcome record carries neither.
         */
        fillQualityBps: 0,
      };
    case 'yield':
      return {
        kind: 'yield',
        riskAdjustedReturnBps: Math.round(
          10_000 * (delta / Math.max(1, worstDrawdown + Math.abs(delta))),
        ),
        maxDrawdownUsd: worstDrawdown,
      };
    case 'health-factor': {
      /**
       * Measured now that a Venus loan can actually be seeded.
       *
       * This reported zeros because the category could not be auditioned at
       * all - `venus-loan` declined, so a health-factor agent was handed a
       * spot balance with no loan in it. With a real leveraged position, the
       * terminal state carries the health factor the agent left behind, and a
       * run that ended below 1.0 is a liquidation the agent did not prevent.
       *
       * Lead time still needs per-block sampling the outcome record does not
       * carry, so it stays zero rather than being estimated. An unmeasured
       * field reads as unmeasured.
       */
      const withHealth = outcomes.filter(
        (o) => typeof o.terminal.detail['healthFactor'] === 'number',
      );
      const missed = withHealth.filter((o) => {
        const hf = o.terminal.detail['healthFactor'] ?? 0;
        return hf > 0 && hf < 1;
      }).length;
      return {
        kind: 'health-factor',
        medianLeadTimeSec: 0,
        missedEvents: missed,
        falseAlarmRate: 0,
      };
    }
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
   * Score many agents, persist the ones that have evidence, and retract the
   * ones that no longer do.
   *
   * Returns the agents it skipped as well as the ones it scored, because "no
   * outcomes yet" is the normal state for most of the catalog and a caller
   * logging only successes would make it look like the scorer was failing.
   *
   * The retraction is the part that is easy to leave out. When auditions that
   * failed stopped counting as evidence, this loop began skipping twenty
   * agents whose published scores stayed exactly where they were - the catalog
   * kept showing a number the scorer would no longer produce, and no amount of
   * re-running fixed it, because nothing here ever removed a row. A number that
   * cannot be withdrawn is not a measurement.
   */
  async scoreAll(
    agents: readonly { readonly id: AgentId; readonly category: AgentCategory }[],
    basis: Score['basis'] = 'simulated',
  ): Promise<{ scored: number; skipped: number; thin: number; retracted: number }> {
    let scored = 0;
    let skipped = 0;
    let thin = 0;
    let retracted = 0;

    for (const { id, category } of agents) {
      const result = await this.scoreAgent(id, category, basis);
      if (result.score === null) {
        skipped += 1;
        retracted += await this.store.deleteScores(id, basis);
        continue;
      }
      if (isThin(result.score)) thin += 1;
      await this.store.putScore(result.score);
      scored += 1;
    }

    return { scored, skipped, thin, retracted };
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
