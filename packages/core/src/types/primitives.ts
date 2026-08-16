/**
 * Shared primitives. Deliberately free of any SDK or chain-library import so
 * that `@bench/core` never has to change when a dependency does.
 */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export type ChainName = 'bsc-mainnet' | 'bsc-testnet';

export interface ChainRef {
  readonly chain: ChainName;
  readonly chainId: number;
}

/** Basis points. 10_000 = 100%. */
export type Bps = number;

/**
 * Token amounts are always integer base units plus the decimals needed to
 * render them. Never use `number` for money anywhere in Bench.
 */
export interface TokenAmount {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
  readonly amount: bigint;
}

/** A half-open block range [from, to). */
export interface BlockRange {
  readonly from: bigint;
  readonly to: bigint;
}

export interface TimeRange {
  readonly start: Date;
  readonly end: Date;
}

/** Domain error taxonomy. Adapters translate vendor errors into these. */
export type BenchErrorCode =
  | 'NOT_IMPLEMENTED'
  | 'NOT_FOUND'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INVALID_AGENT_CARD'
  | 'ENDPOINT_UNREACHABLE'
  | 'PROTOCOL_NONCONFORMANT'
  | 'INSUFFICIENT_FUNDS'
  | 'SPEND_CAP_EXCEEDED'
  | 'SESSION_KEY_REVOKED'
  | 'EGRESS_BUDGET_EXCEEDED'
  | 'FORK_UNAVAILABLE'
  | 'NOT_SUPPORTED_BY_PROVIDER';

export class BenchError extends Error {
  constructor(
    readonly code: BenchErrorCode,
    message: string,
    // `override` because Error already declares `cause`; `noImplicitOverride`
    // makes shadowing it silently an error rather than a subtle surprise.
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BenchError';
  }
}

export const notImplemented = (what: string): never => {
  throw new BenchError('NOT_IMPLEMENTED', `${what} is not implemented yet`);
};
