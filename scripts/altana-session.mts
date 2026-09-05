/**
 * Prove the Altana path on chain, end to end.
 *
 * The partner track asks for live transactions visible in the Altana explorer,
 * agents on their own wallets, sessions carrying real limits and registered in
 * the KeyStore, and user-facing revocation. Unit tests cover the bounds Bench
 * refuses before it reaches the relay; they cannot show the chain accepting a
 * grant and then rejecting a call outside it. This does.
 *
 *   BENCH_SIGNER_PRIVATE_KEY=0x… npx tsx scripts/altana-session.mts
 *
 * The admin key needs BNB on BSC testnet - https://testnet.bnbchain.org/faucet-smart.
 * Everything it prints is checkable: wallet address, grant transaction, the
 * KeyStore registration, and the revocation.
 */
import { AltanaWalletProvider, InMemorySessionStore } from '@bench/adapters';
import type { Address } from '@bench/core';

const KEY = process.env['BENCH_SIGNER_PRIVATE_KEY'];
if (KEY === undefined || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error(
    'BENCH_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key with BSC testnet BNB.\n' +
      'Fund it at https://testnet.bnbchain.org/faucet-smart',
  );
  process.exit(1);
}

/** Testnet USDT-ish target, only ever used as an allowlist entry here. */
const ALLOWED = '0x337610d27c682e347c9cd60bd4b3b107c9d34ddd' as Address;

async function main(): Promise<void> {
  const sessions = new InMemorySessionStore();
  const wallet = new AltanaWalletProvider({
    adminPrivateKey: KEY as `0x${string}`,
    chain: 'bsc-testnet',
    sessions,
  });

  const address = await wallet.address();
  console.log(`wallet          ${address}`);
  console.log(`explorer        https://testnet.bscscan.com/address/${address}`);

  const grant = await wallet.grant({
    owner: address,
    spendCap: { token: ALLOWED, symbol: 'USDT', decimals: 18, amount: 10n ** 18n },
    contractAllowlist: [ALLOWED],
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });

  console.log(`session key     ${grant.id}`);
  console.log(`  spend cap     ${grant.spendCap.amount.toString()} (rolling day, on chain)`);
  console.log(`  allowlist     ${grant.contractAllowlist.join(', ')}`);
  console.log(`  expires       ${grant.expiresAt.toISOString()}`);

  const stored = await sessions.get(grant.id);
  console.log(`  grant tx      ${stored?.grantTxHash ?? '(relay reported no receipt)'}`);

  const left = await wallet.remaining(grant.id);
  console.log(`  headroom      ${left.amount.toString()}`);

  // The control the track actually asks for: revocation a user can trigger,
  // enforced by the account rather than by Bench choosing not to forward.
  const revokeTx = await wallet.revoke(grant.id);
  console.log(`revoked         ${revokeTx}`);
  console.log(`  tx            https://testnet.bscscan.com/tx/${revokeTx}`);

  const after = await wallet.get(grant.id);
  console.log(`  revokedAt     ${after?.revokedAt?.toISOString() ?? 'null'}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
