import { describe, expect, it } from 'vitest';
import { supportsSessionKeys, type Address } from '@bench/core';
import { AltanaWalletProvider, InMemorySessionStore } from '../src/wallet/altana.js';

/**
 * These cover the decisions Bench makes before it ever reaches the relay -
 * the bounds it refuses to grant, and the shape of what it persists. The
 * network half needs a funded BSC testnet wallet and is exercised by
 * `scripts/altana-session.ts`, not here: a unit suite that silently skips
 * because no key is configured is the failure mode this project has already
 * been caught by twice.
 */
const ADMIN = `0x${'11'.repeat(32)}` as const;
const OWNER = `0x${'aa'.repeat(20)}` as Address;
const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;

const provider = () =>
  new AltanaWalletProvider({
    adminPrivateKey: ADMIN,
    chain: 'bsc-testnet',
    sessions: new InMemorySessionStore(),
  });

describe('AltanaWalletProvider', () => {
  it('is the provider the session-key port narrows to', () => {
    // `supportsSessionKeys` is how a call site learns whether capped,
    // revocable authority is available at all, rather than discovering it from
    // a method that throws.
    expect(supportsSessionKeys(provider())).toBe(true);
  });

  it('refuses an admin key that is not a key, without quoting it', async () => {
    expect(
      () =>
        new AltanaWalletProvider({
          adminPrivateKey: '0xnotakey' as never,
          chain: 'bsc-testnet',
          sessions: new InMemorySessionStore(),
        }),
    ).toThrowError(/0x-prefixed 32-byte/);

    // The message must not carry the value: an invalid key is still a secret,
    // and this message lands in every log that catches it.
    try {
      new AltanaWalletProvider({
        adminPrivateKey: '0xdeadbeefsecret' as never,
        chain: 'bsc-testnet',
        sessions: new InMemorySessionStore(),
      });
    } catch (err) {
      expect((err as Error).message).not.toContain('deadbeefsecret');
    }
  });

  it('refuses to grant a session with an empty allowlist', async () => {
    // The SDK reads an omitted `calls` as unrestricted. So an empty Bench
    // allowlist - which means "no contracts" everywhere else in this codebase
    // - would silently become "every contract" on chain: the exact inversion
    // of the bound the user asked for.
    await expect(
      provider().grant({
        owner: OWNER,
        spendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 10n ** 18n },
        contractAllowlist: [],
        expiresAt: new Date(Date.now() + 3_600_000),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses an expiry in the past', async () => {
    await expect(
      provider().grant({
        owner: OWNER,
        spendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 10n ** 18n },
        contractAllowlist: [USDT],
        expiresAt: new Date(Date.now() - 1_000),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('refuses a cap that is not a bound', async () => {
    // Zero is a session that can do nothing; negative is a bound that cannot
    // be exceeded because it was never one. Both reach the relay as a grant
    // that looks successful.
    for (const amount of [0n, -1n]) {
      await expect(
        provider().grant({
          owner: OWNER,
          spendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount },
          contractAllowlist: [USDT],
          expiresAt: new Date(Date.now() + 3_600_000),
        }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });

  it('reports an unknown session as absent, and refuses to price one', async () => {
    const p = provider();
    expect(await p.get('0xnosuchkey')).toBeNull();
    await expect(p.remaining('0xnosuchkey')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not sign with the admin EOA when asked to sign as the account', async () => {
    // A personal_sign here would sign with a different key than the smart
    // account callers believe they are talking to, and would verify against
    // the wrong address. Refused by name rather than approximated.
    await expect(provider().signMessage('hello')).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
    await expect(provider().signTypedData({})).rejects.toMatchObject({
      code: 'NOT_IMPLEMENTED',
    });
  });
});

describe('InMemorySessionStore', () => {
  it('round-trips a grant and records a revocation', async () => {
    const store = new InMemorySessionStore();
    const row = {
      id: '0xpub',
      owner: OWNER,
      walletAddress: OWNER,
      sessionPrivateKey: `0x${'22'.repeat(32)}` as const,
      serialized: '{}',
      publicKey: '0xpub' as const,
      spendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 5n },
      contractAllowlist: [USDT],
      expiresAt: new Date('2027-01-01'),
      revokedAt: null,
      grantTxHash: null,
    };
    await store.put(row);
    expect((await store.get('0xpub'))?.publicKey).toBe('0xpub');

    const at = new Date('2026-09-04T00:00:00Z');
    await store.markRevoked('0xpub', at);
    expect((await store.get('0xpub'))?.revokedAt).toEqual(at);
  });

  it('marking an unknown session revoked is a no-op, not a crash', async () => {
    const store = new InMemorySessionStore();
    await expect(store.markRevoked('0xmissing', new Date())).resolves.toBeUndefined();
  });
});
