import { describe, expect, it } from 'vitest';
import { AnvilForkProvider } from '../src/shadow/anvil-fork.js';
import { VenusLoanSeeder } from '../src/shadow/seeders.js';
import { VENUS } from '../src/shadow/protocols.js';
import { anvilAvailable } from './helpers/anvil.js';

/**
 * Seeds a real Venus position against a real fork of BSC mainnet.
 *
 * `venus-loan` declined for the whole project until now, which meant
 * health-factor agents - one of the four categories the main track scores -
 * were auditioned against a spot balance with no loan in it. They were being
 * measured on a position that had no health factor to manage.
 *
 * Needs an archive RPC, so it skips without one rather than failing. That is
 * the same bargain the other fork tests make, and the reason CI installs
 * Foundry: a suite that skips silently proves nothing.
 */
const ARCHIVE = process.env['BSC_ARCHIVE_RPC_URL'] ?? process.env['BSC_MAINNET_RPC_URL'];
const runnable = anvilAvailable() && ARCHIVE !== undefined && ARCHIVE !== '';

async function headBlock(rpcUrl: string): Promise<bigint> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const body = (await res.json()) as { result: string };
  return BigInt(body.result);
}

describe.skipIf(!runnable)('VenusLoanSeeder against a forked BSC mainnet', () => {
  const template = {
    kind: 'venus-loan' as const,
    label: 'Venus USDT loan',
    params: {
      nativeWei: 10n ** 18n,
      token: '0x55d398326f99059ff775485246999027b3197955',
      vToken: VENUS.vUSDT,
      balanceSlot: 1n,
      supplyAmount: 10_000n * 10n ** 18n,
      targetHealthFactor: 1.5,
      tokenDecimals: 18,
      tokenPriceUsd: 1,
      nativePriceUsd: 687.46,
    },
    capital: {
      token: '0x55d398326f99059ff775485246999027b3197955' as const,
      symbol: 'USDT',
      decimals: 18,
      amount: 10_000n * 10n ** 18n,
    },
  };

  it('supplies collateral and opens a borrow at the health factor asked for', async () => {
    // A recent block, not a fixed one: Venus market parameters and liquidity
    // move, and a hard-coded block would rot into a failure that looks like a
    // seeder bug.
    const head = await headBlock(ARCHIVE ?? '');
    const provider = new AnvilForkProvider({ seeders: [new VenusLoanSeeder()] });
    const fork = await provider.spawn({
      window: {
        id: 'venus-test',
        label: 'venus',
        regime: 'live',
        forkBlock: head - 32n,
        endBlock: 1n,
        seed: 'venus-seed',
      },
      archiveRpcUrl: ARCHIVE ?? '',
    } as never);

    try {
      const opened = await fork.seedPosition(template);

      // Real supply, real borrow, both read back through the protocol.
      expect(opened.openedAt.detail['suppliedUsd']).toBeGreaterThan(9_000);
      expect(opened.openedAt.detail['borrowedUsd']).toBeGreaterThan(1_000);

      // The health factor the template asked for, within the rounding the
      // collateral factor and interest accrual introduce.
      expect(opened.openedAt.detail['healthFactor']).toBeGreaterThan(1.3);
      expect(opened.openedAt.detail['healthFactor']).toBeLessThan(1.8);

      // Net equity, not gross supply: an agent that borrows recklessly must
      // not score the same as one that does not.
      expect(opened.openedAt.valueUsd).toBeLessThan(
        (opened.openedAt.detail['suppliedUsd'] ?? 0) + 1_000,
      );
    } finally {
      await fork.destroy();
    }
  }, 180_000);
});
