import type { AuditionWindow, PositionTemplate } from '@bench/core';

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

const USDT_BSC = '0x55d398326f99059fF775485246999027B3197955';
/** BEP-20 `_balances` mapping slot on the BSC USDT contract. */
const USDT_BALANCE_SLOT = 1n;

const usdt = (whole: bigint) => ({
  token: USDT_BSC as `0x${string}`,
  symbol: 'USDT',
  decimals: 18,
  amount: whole * 10n ** 18n,
});

/**
 * Blocks are chosen per regime and pinned, so a window is replayable: the same
 * fork block and seed produce the same starting state for anyone re-running it.
 * `forkBlock` is overridable from config for a chain whose history has moved.
 */
export interface WindowSpec {
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
}

export function auditionWindows(opts: { readonly forkBlock: bigint }): readonly WindowSpec[] {
  const capital = usdt(10_000n);
  const base = {
    kind: 'spot-balance' as const,
    params: {
      nativeWei: 50n * 10n ** 18n,
      token: USDT_BSC,
      balanceSlot: USDT_BALANCE_SLOT,
      tokenAmount: capital.amount,
    },
    capital,
  };

  return [
    {
      window: {
        id: 'spot-live-1',
        label: 'Recent market',
        regime: 'live',
        forkBlock: opts.forkBlock,
        endBlock: opts.forkBlock + 5_000n,
        seed: 'bench-spot-live-1',
      },
      position: { ...base, label: '10,000 USDT and 50 BNB, unmanaged' },
    },
  ];
}
