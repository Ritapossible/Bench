import type {
  AuditionWindow,
  InterceptedAction,
  PositionTemplate,
  TerminalState,
} from '../types/audition.js';
import type { Address, Hex } from '../types/primitives.js';

export interface SeededPosition {
  /** Throwaway key controlling the mirrored position inside the fork. */
  readonly controller: Address;
  readonly openedAt: TerminalState;
}

/**
 * A running fork the agent talks to believing it is live.
 *
 * The agent is NOT asked to implement a dry-run interface — almost none do.
 * We hand it an RPC endpoint pointing at a forked node and intercept
 * `eth_sendRawTransaction` at the transport layer. See ARCHITECTURE.md 3.3.
 */
export interface ForkHandle {
  readonly id: string;
  /** Give this to the agent as its RPC. It cannot tell the difference. */
  readonly rpcUrl: string;
  seedPosition(t: PositionTemplate): Promise<SeededPosition>;
  /** Called for every intercepted, simulated, never-broadcast transaction. */
  onAction(cb: (a: InterceptedAction) => void): void;
  terminalState(t: PositionTemplate): Promise<TerminalState>;
  /**
   * The fork's gas price, in wei.
   *
   * Needed because gas is the cost the agent's advantage has to beat, and it
   * was not being counted. The TermiX report is required to compare agent
   * against no-agent on time, cost and output quality, and `cost` was the
   * egress meter alone - which is zero for every remote agent, since the shim
   * calls the endpoint directly rather than through the meter. So the report
   * asked "did the agent beat doing nothing net of cost" against a cost of
   * exactly zero, and gas - the one real cost an audition can measure - was
   * not in it.
   */
  gasPriceWei(): Promise<bigint>;
  destroy(): Promise<void>;
}

export interface SpawnForkOptions {
  readonly window: AuditionWindow;
  /** Must be an ARCHIVE node — a pruned node cannot serve historical state. */
  readonly archiveRpcUrl: string;
}

export interface ForkProvider {
  spawn(opts: SpawnForkOptions): Promise<ForkHandle>;
  /** Deterministic hash over {forkBlock, seed, window} for replay verification. */
  replayHash(window: AuditionWindow): Hex;
}

export interface EgressDecision {
  readonly allowed: boolean;
  readonly reason?: 'over-budget' | 'host-not-allowlisted';
}

/**
 * A shadowed agent still makes REAL outbound calls — x402-paid data feeds
 * especially — that cost actual money. Every run gets a hard budget and an
 * outbound host allowlist. Without this, a hundred auditions can bill you for
 * real. Build this alongside the fork harness, never after it.
 */
export interface EgressGuard {
  check(runId: string, host: string, estimatedCostUsd: number): Promise<EgressDecision>;
  record(runId: string, costUsd: number): Promise<void>;
  spent(runId: string): Promise<number>;
}
