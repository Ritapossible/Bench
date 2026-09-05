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
    const payment: PaymentClient = new X402PaymentClient({
      chain: 'bsc-testnet',
      session: {} as never,
    });
    const escrow: EscrowClient = new Erc8183EscrowClient({
      chain: 'bsc-testnet',
      wallet: { address: `0x${'22'.repeat(20)}` },
      signer: {} as never,
    });
    const wallet: WalletProvider = localWallet();
    expect([registry, payment, escrow, wallet].every(Boolean)).toBe(true);
  });

  it('refuses a hire settlement through x402, and says where it belongs', async () => {
    // x402 is an HTTP flow: the merchant answers 402 with its terms and the
    // client signs one. It cannot pay a chosen party a chosen amount, which is
    // what a hire is - so a non-URL resource is refused by name rather than
    // quoted against terms no merchant offered.
    const payment = new X402PaymentClient({ chain: 'bsc-testnet', session: {} as never });
    await expect(
      payment.quote({
        resource: 'agent:bsc-testnet:1581',
        payTo: `0x${'33'.repeat(20)}`,
        amount: { token: `0x${'44'.repeat(20)}`, symbol: 'U', decimals: 18, amount: 1n },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses to escrow a token the kernel does not hold', async () => {
    // The kernel escrows $U at an address it chooses. Substituting it for the
    // token the user agreed to would move a different asset than was agreed.
    const escrow = new Erc8183EscrowClient({
      chain: 'bsc-testnet',
      wallet: { address: `0x${'22'.repeat(20)}` },
      signer: {} as never,
    });
    await expect(
      escrow.openJob({
        agent: { chain: 'bsc-testnet', tokenId: 1n },
        provider: `0x${'33'.repeat(20)}`,
        client: `0x${'55'.repeat(20)}`,
        amount: {
          token: '0x55d398326f99059ff775485246999027b3197955',
          symbol: 'USDT',
          decimals: 18,
          amount: 10n ** 18n,
        },
        taskSpec: 'anything',
        disputeWindowSec: 3600,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it("refuses to submit a deliverable, which is the seller's action", async () => {
    // A buyer that could submit its own deliverable could settle its own
    // escrow.
    const escrow = new Erc8183EscrowClient({
      chain: 'bsc-testnet',
      wallet: { address: `0x${'22'.repeat(20)}` },
      signer: {} as never,
    });
    await expect(escrow.deliver('1', '0x00')).rejects.toMatchObject({
      code: 'NOT_SUPPORTED_BY_PROVIDER',
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
