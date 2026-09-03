import type { AuditionWindow, ChainName, PositionTemplate } from '@bench/core';

/**
 * The audition window library - ARCHITECTURE.md 3.3.
 *
 * A window plus the position every agent is measured on. Both are fixed per
 * audition and shared by every agent in it: that is the entire basis for
 * calling the comparison controlled rather than a post-hoc delta over whichever
 * agents happened to run when.
 *
 * Only `spot-balance` positions appear here, and that is a deliberate limit
 * rather than an oversight. It is the one seeder that is complete; `pcs-lp` and
 * `venus-loan` decline with exactly what they need, and auditioning against a
 * position that cannot be seeded would produce runs that failed for a reason
 * having nothing to do with the agent.
 */

/**
 * Per-chain constants for the spot-balance seeder.
 *
 * The chain is a parameter because the two facts a seeder needs - which
 * contract, and which storage slot holds its balances - are properties of a
 * deployment, not of the protocol. This file previously hard-coded BSC
 * mainnet's USDT while auditions forked BSC testnet, where that address holds
 * no code at all: every agent would have been handed a position denominated in
 * a token that did not exist, and every run would have failed for a reason
 * having nothing to do with the agent.
 *
 * The mainnet entry is verified against the chain rather than asserted:
 * balanceOf for a large holder equals the value at
 * keccak256(abi.encode(holder, 1)), which is what makes slot 1 `_balances`.
 */
interface SpotConstants {
  readonly token: `0x${string}`;
  readonly symbol: string;
  readonly decimals: number;
  readonly balanceSlot: bigint;
  /**
   * The valuation basis for the chain's native token, pinned per window.
   *
   * Pinned rather than fetched, and that is the point: a window's claim is that
   * two agents auditioned days apart ran the same experiment. Valuing the same
   * fork against a live price makes the same behaviour score differently
   * depending on when it was replayed, which breaks the only comparison the
   * audition exists to make. This is a unit of account, not a market quote -
   * read from Chainlink's BNB/USD feed on BSC mainnet and fixed here.
   */
  readonly nativePriceUsd: number;
  /** Stable-pegged, so the peg is the basis for the same reason. */
  readonly tokenPriceUsd: number;
}

const SPOT_CONSTANTS: Partial<Record<ChainName, SpotConstants>> = {
  'bsc-mainnet': {
    token: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    decimals: 18,
    balanceSlot: 1n,
    nativePriceUsd: 687.46,
    tokenPriceUsd: 1,
  },
  // bsc-testnet is deliberately absent. Declining is the honest answer: a
  // testnet spot position would be denominated in a token nobody trades, over
  // liquidity nobody provides, so the resulting rank would measure nothing
  // about how an agent handles a market. Auditions replay real market history;
  // that history only exists on mainnet.
};

/** BSC produces a block every 0.45s, measured. One day is ~192,000 blocks. */
export const BLOCKS_PER_DAY = 192_000n;

/**
 * How far behind the chain head an audition forks.
 *
 * Far enough back that the whole replayed window has already happened and any
 * archive node has settled state for it; near enough that "recent market" is
 * true. One day, which at 0.45s blocks leaves the 5,000-block window - about
 * 37 minutes of trading - comfortably in the past.
 */
export const FORK_LAG_BLOCKS = BLOCKS_PER_DAY;

/**
 * Pin the fork block to a daily grid.
 *
 * A window has to be two things at once: recent, or it stops describing the
 * market anyone is trading in and demands ever-deeper archive state; and
 * pinned, or two agents auditioned an hour apart are not comparable and the
 * word "controlled" is doing no work. Flooring to a grid gives both - every
 * audition in a given day forks the same block, and the next day moves on.
 */
export function forkBlockFor(head: bigint, grid: bigint = BLOCKS_PER_DAY): bigint {
  const target = head - FORK_LAG_BLOCKS;
  if (target <= 0n) return 0n;
  return (target / grid) * grid;
}

const usdt = (c: SpotConstants, whole: bigint) => ({
  token: c.token,
  symbol: c.symbol,
  decimals: c.decimals,
  amount: whole * 10n ** BigInt(c.decimals),
});

/**
 * Blocks are chosen per regime and pinned, so a window is replayable: the same
 * fork block and seed produce the same starting state for anyone re-running it.
 */
export interface WindowSpec {
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
}

/**
 * The windows available for a chain, or none if it has no seeder constants.
 *
 * Returning an empty list rather than throwing keeps this the same shape as the
 * other seeders' refusals: the caller says auditions are off and why, instead
 * of a queue failing hourly forever.
 */
export function auditionWindows(opts: {
  readonly forkChain: ChainName;
  readonly forkBlock: bigint;
}): readonly WindowSpec[] {
  const constants = SPOT_CONSTANTS[opts.forkChain];
  if (constants === undefined) return [];

  const capital = usdt(constants, 10_000n);
  const base = {
    kind: 'spot-balance' as const,
    params: {
      nativeWei: 50n * 10n ** 18n,
      token: constants.token,
      balanceSlot: constants.balanceSlot,
      tokenAmount: capital.amount,
      // The seeder needs these to value the position, and it refuses without
      // them rather than guessing. Their absence is what made every audition
      // fail in production with "position template is missing numeric param".
      nativePriceUsd: constants.nativePriceUsd,
      tokenPriceUsd: constants.tokenPriceUsd,
      tokenDecimals: constants.decimals,
    },
    capital,
  };

  return [
    {
      window: {
        // The block is part of the identity, not a detail of it. A fixed id
        // over a moving block silently mislabels every run: windows are
        // inserted on-conflict-do-nothing, so the row would keep the first
        // block it ever saw while later runs replayed a different one.
        id: `spot-live-${opts.forkChain}-${opts.forkBlock.toString()}`,
        label: 'Recent market',
        regime: 'live',
        forkBlock: opts.forkBlock,
        endBlock: opts.forkBlock + 5_000n,
        seed: `bench-spot-live-${opts.forkBlock.toString()}`,
      },
      position: { ...base, label: `10,000 ${constants.symbol} and 50 BNB, unmanaged` },
    },
  ];
}

/**
 * Tokens whose `_balances` storage slot is known, so a reader's real holding
 * can be mirrored onto a fork.
 *
 * Seeding an ERC-20 balance means writing the mapping slot directly - there is
 * no mint to call on a token we do not own - and the slot is a property of the
 * contract's layout, not of the standard. So it cannot be inferred, and a
 * wrong guess writes into some unrelated variable and produces a position that
 * silently is not the reader's.
 *
 * Every entry here was verified against BSC mainnet the same way slot 1 was
 * for USDT: `balanceOf(holder)` equals the word at
 * `keccak256(abi.encode(holder, slot))` for a large holder. Anything not in
 * this table is reported as unmirrored rather than approximated - a report
 * that quietly drops half of someone's position is worse than one that says
 * which half it could not read.
 */
export const SEEDABLE_TOKENS: Readonly<
  Record<
    string,
    { readonly symbol: string; readonly decimals: number; readonly balanceSlot: bigint }
  >
> = {
  '0x55d398326f99059ff775485246999027b3197955': { symbol: 'USDT', decimals: 18, balanceSlot: 1n },
  '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': { symbol: 'USDC', decimals: 18, balanceSlot: 1n },
  '0xe9e7cea3dedca5984780bafc599bd69add087d56': { symbol: 'BUSD', decimals: 18, balanceSlot: 1n },
  '0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82': { symbol: 'CAKE', decimals: 18, balanceSlot: 1n },
  // WBNB keeps balances at slot 3, not 1. Exactly the reason this is a table
  // of verified facts rather than a default.
  '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c': { symbol: 'WBNB', decimals: 18, balanceSlot: 3n },
};

/** What could and could not be mirrored, so the page can say which. */
export interface MirroredPosition {
  readonly template: PositionTemplate;
  readonly mirroredSymbols: readonly string[];
  readonly unmirroredSymbols: readonly string[];
}

/**
 * Build an audition position from what an address actually holds.
 *
 * This is what makes `/report` a measurement rather than a projection. The
 * page read the position and then had nothing to run against it, so it always
 * returned `position-only` - the headline claim of the whole product, "this
 * agent would have saved you $340 on your position", existed only in fixtures.
 *
 * The native balance is always mirrored. Of the ERC-20 holdings, the largest
 * one whose slot is known becomes the token leg; the rest are named as
 * unmirrored. One token because the seeder writes one mapping, and the
 * alternative - mirroring nothing until every token is supported - is how this
 * feature stayed unbuilt.
 */
export function mirrorPosition(
  live: {
    readonly address: string;
    readonly holdings: readonly {
      readonly token: string;
      readonly symbol: string;
      readonly amount: bigint;
      readonly valuedUsd: number | null;
    }[];
    readonly nativeWei?: bigint;
  },
  forkChain: ChainName,
): MirroredPosition | null {
  const constants = SPOT_CONSTANTS[forkChain];
  if (constants === undefined) return null;

  const seedable = live.holdings
    .filter((h) => h.amount > 0n && SEEDABLE_TOKENS[h.token.toLowerCase()] !== undefined)
    .sort((a, b) => (b.valuedUsd ?? 0) - (a.valuedUsd ?? 0));

  const leg = seedable[0];
  const spec = leg === undefined ? undefined : SEEDABLE_TOKENS[leg.token.toLowerCase()];
  const nativeWei = live.nativeWei ?? 0n;

  // Nothing to seed at all is not a position worth auditioning against: every
  // agent would be handed an empty account and score zero for it.
  if (leg === undefined || spec === undefined) return null;

  const unmirrored = live.holdings
    .filter((h) => h.amount > 0n && h.token.toLowerCase() !== leg.token.toLowerCase())
    .map((h) => h.symbol);

  return {
    template: {
      kind: 'spot-balance',
      label: `${leg.symbol} and BNB held by ${live.address.slice(0, 8)}…`,
      params: {
        nativeWei,
        token: leg.token.toLowerCase() as `0x${string}`,
        balanceSlot: spec.balanceSlot,
        tokenAmount: leg.amount,
        nativePriceUsd: constants.nativePriceUsd,
        // Priced from what the reader's holding was actually worth, so the
        // report is denominated in their position rather than in a default.
        tokenPriceUsd:
          leg.valuedUsd === null || leg.amount === 0n
            ? constants.tokenPriceUsd
            : leg.valuedUsd / (Number(leg.amount) / 10 ** spec.decimals),
        tokenDecimals: spec.decimals,
      },
      capital: {
        token: leg.token.toLowerCase() as `0x${string}`,
        symbol: leg.symbol,
        decimals: spec.decimals,
        amount: leg.amount,
      },
    },
    mirroredSymbols: [leg.symbol, ...(nativeWei > 0n ? ['BNB'] : [])],
    unmirroredSymbols: unmirrored,
  };
}

/** The window an on-demand report runs in. Keyed by address so runs are findable. */
export const reportWindowFor = (address: string, forkBlock: bigint) =>
  ({
    id: `addr-${address.toLowerCase()}-${forkBlock.toString()}`,
    label: 'Your position',
    regime: 'live' as const,
    forkBlock,
    endBlock: forkBlock + 5_000n,
    seed: `bench-addr-${address.toLowerCase()}-${forkBlock.toString()}`,
  }) satisfies AuditionWindow;
