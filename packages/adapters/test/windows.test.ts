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
