import type { AgentCategory, AgentId } from './agent.js';
import type { Baseline } from './audition.js';
import type { TimeRange } from './primitives.js';

/**
 * Simulated (from auditions) or realized (from settled hires). These are NEVER
 * merged into one number — the leaderboard shows two labelled columns, with
 * realized converging on simulated as real hires settle.
 */
export type ScoreBasis = 'simulated' | 'realized';

/**
 * A score is invalid without its basis, window, and sample size, so the type
 * makes all three mandatory. This is the honesty rule from ARCHITECTURE.md
 * section 6 enforced by the compiler rather than by reviewer discipline: you
 * cannot construct a bare number and render it as a track record.
 */
export interface Score {
  readonly agent: AgentId;
  readonly category: AgentCategory;
  readonly basis: ScoreBasis;
  readonly window: TimeRange;
  /** Auditions (simulated) or settled jobs (realized) behind this number. */
  readonly sampleSize: number;
  readonly baseline: Baseline;
  /** Category-normalised to [0, 1] for cross-category ranking. */
  readonly normalized: number;
  /**
   * Mean dollar delta against the baseline across `sampleSize` auditions.
   *
   * Recorded rather than reconstructed. `normalized` is a bounded tanh of
   * delta-over-capital, so it is not invertible back to dollars, and the
   * catalog page used to display `(normalized - 0.5) * 800` under the caption
   * "vs doing nothing" - a dollar figure that matched no dollar amount the
   * system had ever measured. Anything showing money has to read this field.
   */
  readonly meanDeltaUsd: number;
  /**
   * Mean capital the auditions were run with, in USD.
   *
   * Carried beside the delta because the delta is meaningless without it:
   * +$142 on $5,000 and +$142 on $500,000 are not the same result, and
   * `normalized` is the only place that ratio currently survives.
   */
  readonly capitalUsd: number;
  /** The raw category-native metric, kept for display and audit. */
  readonly metric: CategoryMetric;
}

export type CategoryMetric =
  | {
      readonly kind: 'rebalancing';
      readonly inRangeBps: number;
      readonly rebalanceCount: number;
      readonly feesEarnedUsd: number;
    }
  | {
      readonly kind: 'yield';
      readonly riskAdjustedReturnBps: number;
      readonly maxDrawdownUsd: number;
    }
  | {
      readonly kind: 'grid';
      readonly realizedPnlUsd: number;
      readonly maxDrawdownUsd: number;
      readonly fillQualityBps: number;
    }
  | {
      readonly kind: 'monitoring';
      readonly precision: number;
      readonly recall: number;
      readonly falseAlarmRate: number;
    }
  | {
      readonly kind: 'health-factor';
      readonly medianLeadTimeSec: number;
      readonly missedEvents: number;
      readonly falseAlarmRate: number;
    };

/**
 * Sample size below which a score is shown but explicitly marked thin. Never
 * suppress the number — show it with its n. Overclaiming rigor on a handful of
 * runs is the failure mode we are avoiding, and TermiX's judges trade for a
 * living.
 */
export const THIN_SAMPLE_THRESHOLD = 20;

export const isThin = (s: Score): boolean => s.sampleSize < THIN_SAMPLE_THRESHOLD;
