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

/**
 * Render a token amount for a human.
 *
 * Base units are correct for arithmetic and unreadable in a sentence - and the
 * decision trace and the mandate's refusal explanations are both read by
 * people deciding whether an agent misbehaved. Trailing zeros are trimmed so a
 * whole number reads as one.
 */
export function formatTokenAmount(
  a: TokenAmount,
  opts: { readonly symbol?: boolean; readonly maxFractionDigits?: number } = {},
): string {
  const negative = a.amount < 0n;
  const abs = negative ? -a.amount : a.amount;
  const base = 10n ** BigInt(a.decimals);
  const whole = (abs / base).toString();
  const fracFull = (abs % base).toString().padStart(a.decimals, '0');

  let frac = fracFull.replace(/0+$/, '');
  const limit = opts.maxFractionDigits;
  if (limit !== undefined && frac.length > limit) {
    // Truncated, not rounded, and by string slicing rather than by dividing
    // through a float - an 18-decimal balance does not survive Number().
    const cut = frac.slice(0, limit).replace(/0+$/, '');
    // A balance that is real but smaller than the display precision must not
    // render as zero. Better a long number than a wrong one, so in that case
    // the full fraction is kept and the reader sees what is actually there.
    frac = cut === '' && whole === '0' ? frac : cut;
  }

  const num = `${negative ? '-' : ''}${whole}${frac === '' ? '' : `.${frac}`}`;
  return opts.symbol === false ? num : `${num} ${a.symbol}`;
}

/** Same, for a bare base-unit value whose token is known from context. */
export const formatBaseUnits = (v: bigint, decimals: number, maxFractionDigits?: number): string =>
  formatTokenAmount({ token: '0x', symbol: '', decimals, amount: v } as TokenAmount, {
    symbol: false,
    ...(maxFractionDigits === undefined ? {} : { maxFractionDigits }),
  });

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
  /** A persisted decision trace no longer verifies against its own hash chain. */
  | 'TRACE_TAMPERED'
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
