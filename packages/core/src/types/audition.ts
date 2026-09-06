import type { AgentId } from './agent.js';
import type { Address, Hex, TokenAmount } from './primitives.js';

/**
 * The position an agent auditions against. The hackathon wedge is PancakeSwap
 * LP and Venus health factor (ARCHITECTURE.md section 8); other kinds are
 * additive and must not require changing the shadow engine.
 */
export type PositionKind = 'pcs-lp' | 'venus-loan' | 'spot-balance';

export interface PositionTemplate {
  readonly kind: PositionKind;
  readonly label: string;
  /** Kind-specific setup, validated by the seeder for that kind. */
  readonly params: Readonly<Record<string, string | number | bigint>>;
  readonly capital: TokenAmount;
}

/**
 * A replayable audition window. Every field here is required to re-run the
 * audition and check Bench's arithmetic — that reproducibility is what makes
 * the record credible instead of a number Bench asserts.
 */
export interface AuditionWindow {
  readonly id: string;
  readonly label: string;
  /** Regime being tested; the library ships one of each per position kind. */
  readonly regime: 'crash' | 'chop' | 'rally' | 'live';
  readonly forkBlock: bigint;
  readonly endBlock: bigint;
  readonly seed: string;
}

/** Who or what we compare an agent against. */
export type Baseline =
  | { readonly kind: 'do-nothing' }
  | { readonly kind: 'peer-median' }
  | { readonly kind: 'naive-threshold'; readonly threshold: number };

/**
 * A transaction the agent tried to broadcast. Captured at the RPC layer and
 * simulated against fork state — never broadcast. The agent believes it is
 * live; see ARCHITECTURE.md section 3.3.
 */
export interface InterceptedAction {
  readonly seq: number;
  readonly at: Date;
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  /** Best-effort human-readable decode; null when the ABI is unknown. */
  readonly decoded: { readonly signature: string; readonly args: unknown } | null;
  readonly simulated: {
    readonly success: boolean;
    readonly gasUsed: bigint;
    readonly revertReason?: string;
  };
}

export type ShadowRunStatus = 'queued' | 'running' | 'complete' | 'failed' | 'egress-halted';

export interface ShadowRun {
  readonly id: string;
  readonly agent: AgentId;
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
  readonly status: ShadowRunStatus;
  readonly startedAt: Date | null;
  readonly finishedAt: Date | null;
  /** Real money spent on the agent's outbound x402 data calls during the run. */
  readonly egressSpentUsd: number;
  /**
   * Gas the agent's transactions burned during the run, valued in USD.
   *
   * Separate from egress because they are different costs with different
   * reliability: gas is measured from the receipts of transactions this system
   * executed, egress is metered only for in-process agents. Reported as the
   * cost an agent's advantage has to beat.
   */
  readonly gasSpentUsd: number;
  readonly failureReason?: string;
  /**
   * Which of the four things went wrong, decided from the error's code at the
   * moment it was caught rather than read back out of `failureReason` later.
   */
  readonly failureKind?: import('../audition-outcome.js').AuditionOutcomeKind;
}

/** Terminal state of a position, valued in a single numeraire for comparison. */
export interface TerminalState {
  readonly valueUsd: number;
  readonly detail: Readonly<Record<string, number>>;
}

export interface OutcomeRecord {
  readonly runId: string;
  readonly terminal: TerminalState;
  readonly deltaVsDoNothingUsd: number;
  readonly deltaVsPeerMedianUsd: number | null;
  readonly maxDrawdownUsd: number;
  readonly actionCount: number;
}
