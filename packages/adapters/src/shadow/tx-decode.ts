import type { Hex } from '@bench/core';
import { decodeFunctionData, parseAbi, slice, toFunctionSelector } from 'viem';

/**
 * Best-effort decoding of an intercepted transaction.
 *
 * The audition record is read by humans deciding whether to hire, so
 * "0xa9059cbb…" is worth much less than "transfer(address,uint256)". Decoding
 * is deliberately best-effort and total: an unknown selector yields `null`
 * rather than throwing, because an agent calling something we have no ABI for
 * is the normal case, not an error.
 *
 * The registry covers the hackathon wedge — PancakeSwap LP and Venus health
 * factor — plus ERC-20, which every agent touches.
 */
const SIGNATURES = [
  // ERC-20
  'function transfer(address to, uint256 amount)',
  'function transferFrom(address from, address to, uint256 amount)',
  'function approve(address spender, uint256 amount)',
  // PancakeSwap v3 position manager
  'function mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))',
  'function increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))',
  'function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))',
  'function collect((uint256,address,uint128,uint128))',
  'function burn(uint256 tokenId)',
  // PancakeSwap router
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  'function multicall(bytes[] data)',
  // Venus / Compound-style
  'function mint(uint256 mintAmount)',
  'function redeem(uint256 redeemTokens)',
  'function redeemUnderlying(uint256 redeemAmount)',
  'function borrow(uint256 borrowAmount)',
  'function repayBorrow(uint256 repayAmount)',
  'function enterMarkets(address[] vTokens)',
  'function exitMarket(address vToken)',
] as const;

const ABI = parseAbi(SIGNATURES);

/** selector -> human signature. Built once; collisions are impossible within one ABI. */
const BY_SELECTOR = new Map<Hex, string>(
  SIGNATURES.map((sig) => [toFunctionSelector(sig) as Hex, sig.replace(/^function /, '')]),
);

export interface DecodedAction {
  readonly signature: string;
  readonly args: unknown;
}

export function decodeAction(data: Hex | undefined | null): DecodedAction | null {
  if (data === undefined || data === null || data.length < 10) return null;

  const selector = slice(data, 0, 4) as Hex;
  const signature = BY_SELECTOR.get(selector);
  if (signature === undefined) return null;

  try {
    const { args } = decodeFunctionData({ abi: ABI, data });
    // Args may contain bigints, which do not survive JSON.stringify. Render
    // them as strings here rather than at every display site.
    return { signature, args: jsonSafe(args) };
  } catch {
    // A known selector with unparseable calldata is still worth reporting by
    // name — the agent's intent is legible even when its arguments are not.
    return { signature, args: null };
  }
}

/** Recursively replace bigints with decimal strings so records serialise. */
export function jsonSafe(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, jsonSafe(x)]));
  }
  return v;
}

/** Exposed for tests and for callers wanting to know what Bench can decode. */
export const KNOWN_SELECTORS: readonly string[] = [...BY_SELECTOR.values()];
