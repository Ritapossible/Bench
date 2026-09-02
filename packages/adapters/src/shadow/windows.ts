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
}

const SPOT_CONSTANTS: Partial<Record<ChainName, SpotConstants>> = {
  'bsc-mainnet': {
    token: '0x55d398326f99059fF775485246999027B3197955',
    symbol: 'USDT',
    decimals: 18,
    balanceSlot: 1n,
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
