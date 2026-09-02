import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { BenchError } from '@bench/core';
import { EvmLocalWalletProvider } from '../src/wallet/providers.js';

/**
 * Every wallet method used to throw, so Bench had no signing capability at all
 * while the site described a session key signing cleared actions. This is the
 * one custody model the build can implement; the remote providers still refuse,
 * which is the honest answer for an SDK this build does not carry.
 */
const key = generatePrivateKey();
const wallet = () =>
  new EvmLocalWalletProvider({
    privateKey: key,
    chain: 'bsc-testnet',
    rpcUrl: 'http://127.0.0.1:1',
  });

describe('EvmLocalWalletProvider', () => {
  it('derives the address the key actually controls', async () => {
    expect(await wallet().address()).toBe(privateKeyToAccount(key).address);
  });

  it('signs a message recoverably', async () => {
    expect(await wallet().signMessage('bench')).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('signs EIP-712 typed data', async () => {
    const sig = await wallet().signTypedData({
      domain: { name: 'Bench', version: '1', chainId: 97 },
      types: { Mandate: [{ name: 'cap', type: 'uint256' }] },
      primaryType: 'Mandate',
      message: { cap: 1n },
    });
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it('refuses a typed-data payload it has not checked', async () => {
    // The port types this `unknown`. Casting it through to viem would produce a
    // signature over something nobody inspected, which is the one outcome a
    // signing function must never have.
    for (const bad of [null, 'nope', {}, { primaryType: 'X' }]) {
      await expect(wallet().signTypedData(bad)).rejects.toBeInstanceOf(BenchError);
    }
  });

  it('refuses a malformed key without putting it in the message', async () => {
    // An invalid key is still a secret, and a message quoting it lands in every
    // log that catches this.
    try {
      new EvmLocalWalletProvider({
        privateKey: '0xdeadbeef',
        chain: 'bsc-testnet',
        rpcUrl: 'http://127.0.0.1:1',
      });
      expect.unreachable('should have refused');
    } catch (err) {
      expect(err).toBeInstanceOf(BenchError);
      expect((err as BenchError).message).not.toContain('deadbeef');
    }
  });
});
