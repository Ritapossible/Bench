import {
  BenchError,
  supportsSessionKeys,
  type EscrowClient,
  type PaymentClient,
  type RegistryClient,
  type WalletProvider,
} from '@bench/core';
import { describe, expect, it } from 'vitest';
import { Erc8004RegistryClient } from '../src/chain/erc8004-registry.js';
import { Erc8183EscrowClient } from '../src/chain/erc8183-escrow.js';
import { X402PaymentClient } from '../src/chain/x402-payment.js';
import { FakeRegistryClient } from '../src/fakes.js';
import { EvmLocalWalletProvider, TwakWalletProvider } from '../src/wallet/providers.js';
import { AltanaWalletProvider, InMemorySessionStore } from '../src/wallet/altana.js';

/**
 * A throwaway key. EvmLocalWalletProvider now takes one because it actually
 * signs - every method used to throw, so the constructor needed nothing and
 * the wallet could do nothing.
 */
const localWallet = () =>
  new EvmLocalWalletProvider({
    privateKey: `0x${'11'.repeat(32)}`,
    chain: 'bsc-testnet',
    rpcUrl: 'http://127.0.0.1:1',
  });

/**
 * Phase 0's real deliverable is the seam. These assertions are mostly
 * compile-time: if an adapter drifts from its port, `tsc` fails before vitest
 * ever runs. The runtime cases below cover the parts types cannot express.
 */
/** Enough to construct the client; no request is made in these tests. */
const registryOpts = {
  chain: 'bsc-testnet',
  rpcUrl: 'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
  identityRegistry: `0x${'11'.repeat(20)}`,
} as const;

describe('port conformance', () => {
  it('binds every adapter to its port', () => {
    const registry: RegistryClient = new Erc8004RegistryClient(registryOpts);
    const payment: PaymentClient = new X402PaymentClient();
    const escrow: EscrowClient = new Erc8183EscrowClient();
    const wallet: WalletProvider = localWallet();
    expect([registry, payment, escrow, wallet].every(Boolean)).toBe(true);
  });

  it('fails unimplemented adapter methods loudly, not silently', async () => {
    await expect(new X402PaymentClient().quote({} as never)).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });

  it('narrows session-key support to Altana only', () => {
    expect(
      supportsSessionKeys(
        new AltanaWalletProvider({
          adminPrivateKey: `0x${'11'.repeat(32)}`,
          chain: 'bsc-testnet',
          sessions: new InMemorySessionStore(),
        }),
      ),
    ).toBe(true);
    expect(supportsSessionKeys(localWallet())).toBe(false);
    expect(supportsSessionKeys(new TwakWalletProvider())).toBe(false);
  });
});

describe('fakes', () => {
  it('lets downstream phases run with no chain', async () => {
    const fake = new FakeRegistryClient();
    expect(await fake.listAgents()).toEqual([]);
    await fake.writeValidation({ agent: { chain: 'bsc-testnet', tokenId: 1n } } as never);
    expect(fake.writes).toHaveLength(1);
  });

  it('models unresolvable cards as the normal path', async () => {
    // ~96% of BSC agent cards do not resolve. Callers must handle this, so the
    // fake makes it the default rather than a rare branch.
    await expect(new FakeRegistryClient().resolveCard('ipfs://nope')).rejects.toBeInstanceOf(
      BenchError,
    );
  });
});
