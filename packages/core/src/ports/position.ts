import type { Address, ChainName } from '../types/primitives.js';

/**
 * Reading a real address's real position from a real chain - ARCHITECTURE.md 3.8.
 *
 * Separate from the audition machinery on purpose, because the two halves of
 * "what would an agent have done with your position" are different kinds of
 * claim and must not be presented as one:
 *
 *  - **What you hold** is a fact. It is on chain right now, anyone can read it,
 *    and there is no reason for it ever to be simulated. This port reads it.
 *  - **What an agent would have done with it** is a counterfactual. That agent
 *    did not manage this position, so no amount of chain data answers it - the
 *    event never happened. The only way to answer is to replay history against
 *    a fork and let the agent act, which is the shadow engine's job.
 *
 * Collapsing the two would let a simulated number inherit the credibility of a
 * measured one. Keeping them apart is what lets the page say which is which.
 */

/** One token balance, valued only when a price oracle actually had a price. */
export interface Holding {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: bigint;
  /**
   * Null when no feed covers this token, or its price was too stale to use.
   * Never a guess: an unvalued holding is shown as an amount, which is still
   * true, rather than as a dollar figure that is not.
   */
  readonly usdValue: number | null;
  /** When the price used was published on chain. Null when unvalued. */
  readonly pricedAt: Date | null;
}

/**
 * A concentrated-liquidity position, reported without a dollar value.
 *
 * Valuing a v3 position means reconstructing token amounts from the pool's
 * current tick and the position's range, and doing that wrong produces a
 * confident, precise, incorrect number. The pair and whether it is in range are
 * read directly and are exactly true, so those are what get reported until the
 * tick maths is implemented and tested.
 */
export interface LpPosition {
  readonly tokenId: bigint;
  readonly token0: Address;
  readonly token1: Address;
  readonly symbol0: string;
  readonly symbol1: string;
  readonly feeBps: number;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  /** Null when the pool could not be read. */
  readonly inRange: boolean | null;
}

export interface LivePosition {
  readonly address: Address;
  readonly chain: ChainName;
  /** The block this was read at, so the reading is reproducible. */
  readonly blockNumber: bigint;
  readonly readAt: Date;
  readonly holdings: readonly Holding[];
  readonly lpPositions: readonly LpPosition[];
  /** Sum of the holdings that could be priced. Excludes LP positions. */
  readonly valuedUsd: number;
  /** True when something was held but could not be priced, so the total is a floor. */
  readonly partiallyValued: boolean;
}

export interface PositionReader {
  readonly chain: ChainName;
  /** Never throws for an address that simply holds nothing - that is an answer. */
  read(address: Address): Promise<LivePosition>;
}

/** An address holding nothing at all. Distinct from "we could not read it". */
export const isEmpty = (p: LivePosition): boolean =>
  p.holdings.every((h) => h.amount === 0n) && p.lpPositions.length === 0;
