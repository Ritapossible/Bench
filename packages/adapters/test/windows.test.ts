import { describe, expect, it } from 'vitest';
import {
  auditionWindows,
  forkBlockFor,
  BLOCKS_PER_DAY,
  FORK_LAG_BLOCKS,
} from '../src/shadow/windows.js';

/**
 * These pin down two bugs that shipped together and would have made every
 * audition meaningless the moment an archive node was configured.
 */
describe('auditionWindows', () => {
  it('denominates a mainnet fork in a token that exists on mainnet', async () => {
    // The seeded token used to be BSC mainnet USDT while the fork was testnet,
    // where that address holds no code. Every agent would have been handed a
    // position in a token that did not exist.
    const [spec] = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_000_000n });
    expect(spec).toBeDefined();
    expect(spec?.position.capital.symbol).toBe('USDT');
    expect(spec?.position.params['token']).toBe('0x55d398326f99059fF775485246999027B3197955');
    // Verified against the chain: balanceOf(holder) equals storage at
    // keccak256(abi.encode(holder, 1)).
    expect(spec?.position.params['balanceSlot']).toBe(1n);
  });

  it('declines a chain it has no verified constants for', () => {
    // Declining is the honest answer, and matches how the other seeders refuse.
    // A testnet spot position would be denominated in a token nobody trades.
    expect(auditionWindows({ forkChain: 'bsc-testnet', forkBlock: 40_000_000n })).toEqual([]);
  });

  it('puts the fork block in the window id', () => {
    // Windows are inserted on-conflict-do-nothing. A fixed id over a moving
    // block would keep the first block it ever saw while later runs replayed a
    // different one - silently mislabelling every run after the first.
    const [a] = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_000_000n });
    const [b] = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_192_000n });
    expect(a?.window.id).not.toBe(b?.window.id);
    expect(a?.window.id).toContain('40000000');
  });

  it('keeps the replayed window entirely in the past', () => {
    const head = 119_586_358n;
    const [spec] = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: forkBlockFor(head) });
    expect(spec?.window.endBlock).toBeLessThan(head);
  });
});

describe('forkBlockFor', () => {
  it('lags the head by about a day', () => {
    const head = 119_586_358n;
    const block = forkBlockFor(head);
    expect(head - block).toBeGreaterThanOrEqual(FORK_LAG_BLOCKS);
    // At most two days: one for the lag, one for the grid it floors onto.
    expect(head - block).toBeLessThan(FORK_LAG_BLOCKS + BLOCKS_PER_DAY);
  });

  it('is stable across a day, so agents auditioned hours apart are comparable', () => {
    // The whole basis for calling the comparison controlled. Two agents that
    // forked different blocks were never running the same experiment.
    const head = 119_586_358n;
    const anHourLater = head + 8_000n; // 0.45s blocks
    expect(forkBlockFor(anHourLater)).toBe(forkBlockFor(head));
  });

  it('moves on to the next day', () => {
    const head = 119_586_358n;
    expect(forkBlockFor(head + BLOCKS_PER_DAY)).toBe(forkBlockFor(head) + BLOCKS_PER_DAY);
  });

  it('never returns a negative block on a young chain', () => {
    expect(forkBlockFor(100n)).toBe(0n);
  });
});

describe('the window and the seeder agree', () => {
  it('supplies every param the spot seeder requires', async () => {
    // The seeder refuses a template missing a numeric param rather than
    // guessing, and the window did not carry `nativePriceUsd` - so every
    // audition in production failed with "position template is missing numeric
    // param", after the fork had already been spawned. A unit test comparing
    // two hand-written lists would drift; this asks the seeder itself.
    const { SpotBalanceSeeder } = await import('../src/shadow/seeders.js');
    const seeder = new SpotBalanceSeeder();
    const [spec] = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_000_000n });
    expect(spec).toBeDefined();

    const balances = new Map<string, bigint>();
    const ctx = {
      controller: '0x1111111111111111111111111111111111111111' as const,
      rpc: async (method: string, params: readonly unknown[]): Promise<unknown> => {
        if (method === 'eth_getBalance') return '0x2b5e3af16b1880000'; // 50 BNB
        if (method === 'eth_getStorageAt') {
          return `0x${(balances.get(String(params[1])) ?? 0n).toString(16).padStart(64, '0')}`;
        }
        if (method === 'anvil_setStorageAt') {
          balances.set(String(params[1]), BigInt(String(params[2])));
          return null;
        }
        return null;
      },
    };

    const terminal = await seeder.seed(ctx, spec!.position);
    // 50 BNB priced, plus 10,000 USDT at the peg.
    expect(terminal.valueUsd).toBeGreaterThan(40_000);
    expect(terminal.detail['nativeUsd']).toBeGreaterThan(0);
  });

  it('pins the valuation basis rather than leaving it to the day it runs', () => {
    // A window's claim is that two agents auditioned days apart ran the same
    // experiment. A live price makes identical behaviour score differently
    // depending on when it was replayed.
    const a = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_000_000n });
    const b = auditionWindows({ forkChain: 'bsc-mainnet', forkBlock: 40_000_000n });
    expect(a[0]?.position.params['nativePriceUsd']).toBe(b[0]?.position.params['nativePriceUsd']);
    expect(typeof a[0]?.position.params['nativePriceUsd']).toBe('number');
  });
});

describe('the price a position is scored at', () => {
  /**
   * A guard on the constant, not on the code path.
   *
   * `nativePriceUsd` was hardcoded at 687.46 while PancakeSwap quoted 757.74 -
   * a 10% gap that became the score the moment an agent could trade between
   * the two legs. Selling BNB was credited a fictional 10% loss and buying it
   * a fictional 10% gain, on every position, for reasons nothing to do with
   * the agent. Terminal valuation now quotes the fork's own pool, so this
   * constant only survives as a fallback - but it is still what `/report`
   * decides the $25 floor against, and a number nobody has to maintain is a
   * number nobody does maintain.
   */
  it('keeps the fallback close enough to be a fallback', () => {
    const spec = auditionWindows({ forkBlock: 40_000_000n, forkChain: 'bsc-mainnet' })[0];
    const price = spec?.position.params['nativePriceUsd'];
    expect(typeof price).toBe('number');
    // Deliberately wide: this is a staleness alarm, not a price feed. If BNB
    // has left this band the constant needs re-reading from the chain, and the
    // comment above says why that matters.
    expect(price as number).toBeGreaterThan(300);
    expect(price as number).toBeLessThan(2_000);
  });
});
