import { describe, expect, it } from 'vitest';
import { AnvilForkProvider } from '../src/shadow/anvil-fork.js';
import { PancakeLpSeeder } from '../src/shadow/seeders.js';
import { anvilAvailable } from './helpers/anvil.js';

/**
 * Mints a real PancakeSwap v3 position on a forked mainnet.
 *
 * `pcs-lp` declined for the whole project, so rebalancing agents - one of the
 * four judged categories, and the whole of the PancakeSwap track - were
 * auditioned on a spot balance with no tick range. `inRangeBps` was computed
 * from drawdown because there was no range to be in.
 */
const ARCHIVE = process.env['BSC_ARCHIVE_RPC_URL'] ?? process.env['BSC_MAINNET_RPC_URL'];
const runnable = anvilAvailable() && ARCHIVE !== undefined && ARCHIVE !== '';

async function headBlock(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  return BigInt(((await res.json()) as { result: string }).result);
}

describe.skipIf(!runnable)('PancakeLpSeeder against a forked BSC mainnet', () => {
  const USDT = '0x55d398326f99059ff775485246999027b3197955';
  const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';

  const template = {
    kind: 'pcs-lp' as const,
    label: 'USDT/WBNB concentrated liquidity',
    params: {
      nativeWei: 10n ** 18n,
      token0: USDT,
      token1: WBNB,
      token0Slot: 1n,
      // Verified on chain: WBNB keeps balances at slot 3.
      token1Slot: 3n,
      fee: 500,
      amount0: 10_000n * 10n ** 18n,
      amount1: 15n * 10n ** 18n,
      rangeWidthTicks: 20,
      token0PriceUsd: 1,
      token1PriceUsd: 687.46,
      token0Decimals: 18,
      token1Decimals: 18,
      nativePriceUsd: 687.46,
    },
    capital: {
      token: USDT as `0x${string}`,
      symbol: 'USDT',
      decimals: 18,
      amount: 10_000n * 10n ** 18n,
    },
  };

  it('mints a position with real liquidity around the pool price', async () => {
    const head = await headBlock(ARCHIVE ?? '');
    const provider = new AnvilForkProvider({ seeders: [new PancakeLpSeeder()] });
    const fork = await provider.spawn({
      window: {
        id: 'pcs-test',
        label: 'pcs',
        regime: 'live',
        forkBlock: head - 32n,
        endBlock: head,
        seed: 'pcs-seed',
      },
      archiveRpcUrl: ARCHIVE ?? '',
    } as never);

    try {
      const opened = await fork.seedPosition(template);

      // A real NFT with real liquidity, not an empty mint.
      expect(opened.openedAt.detail['positions']).toBe(1);
      expect(opened.openedAt.detail['liquidity']).toBeGreaterThan(0);
      expect(opened.openedAt.detail['activePositions']).toBe(1);

      // The range is centred on the live tick, so both legs went in - a
      // single-sided mint would leave one wallet balance untouched.
      expect(opened.openedAt.detail['wallet0Usd']).toBeLessThan(10_000);
      expect(opened.openedAt.detail['wallet1Usd']).toBeLessThan(15 * 687.46);
    } finally {
      await fork.destroy();
    }
  }, 180_000);
});
