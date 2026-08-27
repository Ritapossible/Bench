/**
 * ARCHITECTURE.md 2.1, made runnable — and it is the demo's beat 2.
 *
 *   npm run gate:demo
 *
 * A hired agent tries to do something it never did in audition, and the
 * transaction dies before it reaches the chain. The script then *proves* it
 * died, by reading the chain rather than by asserting.
 *
 * Requires `anvil` on PATH (or ANVIL_BINARY). No archive node and no network:
 * a local anvil stands in for BSC. In the real deployment upstream is a node
 * and the signer is a capped Altana session key, and the property is the same
 * one — a refused transaction is never forwarded, so there is no state to
 * unwind and nothing for a reorg to resurrect. It simply never happened.
 */
import { AuditionRunner, type ShadowAgent } from '@bench/services';
import { AnvilForkProvider, controllerFor, startAnvil, startGatedSession } from '@bench/adapters';
import {
  deriveEnvelope,
  type AuditionWindow,
  type InterceptedAction,
  type PositionTemplate,
} from '@bench/core';
import { createWalletClient, defineChain, formatEther, http, parseEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const chain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const SEED = '0x9a7e11';
const VENDOR = '0x1111111111111111111111111111111111111111'; // seen in every audition
const ATTACKER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'; // seen in none

const WINDOW: AuditionWindow = {
  id: 'gate-demo',
  label: 'Chop — 1 Aug 2026',
  regime: 'chop',
  forkBlock: 48_120_000n,
  endBlock: 48_140_000n,
  seed: SEED,
};

const POSITION: PositionTemplate = {
  kind: 'spot-balance',
  label: '10 BNB spot @ $600',
  params: { nativeWei: 10n * 10n ** 18n, nativePriceUsd: 600 },
  capital: {
    token: '0x0000000000000000000000000000000000000000',
    symbol: 'BNB',
    decimals: 18,
    amount: 10n * 10n ** 18n,
  },
};

const wallet = (rpcUrl: string) =>
  createWalletClient({
    account: privateKeyToAccount(controllerFor(SEED).privateKey),
    chain,
    transport: http(rpcUrl),
  });

/** What this agent does for a living: pay one vendor, modest amounts. */
const honest: ShadowAgent = {
  id: 'kestrel',
  name: 'Kestrel LP Rebalancer',
  async run({ rpcUrl }) {
    const w = wallet(rpcUrl);
    await w.sendTransaction({ to: VENDOR, value: parseEther('0.05') });
    await w.sendTransaction({ to: VENDOR, value: parseEther('0.05') });
  },
};

const rpc = async (url: string, method: string, params: readonly unknown[]): Promise<unknown> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return ((await res.json()) as { result?: unknown }).result;
};

async function main(): Promise<void> {
  // ---- 1. Audition ----------------------------------------------------
  const provider = new AnvilForkProvider({ forkless: true, chainId: 31337 });
  const runner = new AuditionRunner({ forks: provider });

  console.log('\n1. AUDITION — three runs, recording what the agent does\n');

  const runs: { actions: readonly InterceptedAction[]; positionDropUsd: number }[] = [];
  for (let i = 0; i < 3; i += 1) {
    const report = await runner.run({
      window: { ...WINDOW, id: `${WINDOW.id}-${i}` },
      position: POSITION,
      agents: [honest],
      archiveRpcUrl: 'forkless',
    });
    const r = report.results[0]!;
    runs.push({ actions: r.actions, positionDropUsd: Math.max(0, -r.deltaVsDoNothingUsd) });
    console.log(
      `   run ${i + 1}: ${r.actions.length} actions, position ${r.deltaVsDoNothingUsd.toFixed(2)} USD`,
    );
  }

  const envelope = deriveEnvelope(runs);
  console.log('\n   Envelope derived from that behaviour:');
  console.log(`     recipients seen      ${envelope.recipients.join(', ')}`);
  console.log(`     max single transfer  ${formatEther(envelope.maxSingleValueWei)} BNB`);
  console.log(`     max actions per run  ${envelope.maxActionCount}`);
  console.log(`     sample size          ${envelope.sampleSize} auditions`);

  // ---- 2. Hire --------------------------------------------------------
  console.log('\n2. HIRE — same machinery, now in the signing path\n');

  const live = await startAnvil({ chainId: 31337 });
  const controller = controllerFor(SEED).address;
  await rpc(live.url, 'anvil_setBalance', [controller, `0x${(10n ** 19n).toString(16)}`]);

  const session = await startGatedSession({ upstreamRpcUrl: live.url, envelope });
  const w = wallet(session.rpcUrl);

  try {
    // In-policy: exactly what it did in audition.
    await w.sendTransaction({ to: VENDOR, value: parseEther('0.05') });
    console.log('   ✓ pays the vendor 0.05 BNB — allowed, landed on chain');

    // Out of policy: an address this agent has never sent to. This is what a
    // prompt-injected or compromised agent looks like on its first move.
    let refused = false;
    try {
      await w.sendTransaction({ to: ATTACKER, value: parseEther('5') });
    } catch {
      refused = true;
    }
    console.log(
      `   ${refused ? '✗' : '!!'} tries to send 5 BNB to an address it never touched — ${refused ? 'REFUSED' : 'ALLOWED (bug)'}`,
    );

    const blocked = session.decisions.filter((d) => !d.decision.allowed);
    for (const b of blocked) console.log(`\n   ${b.decision.explanation}`);
    console.log(`\n   rules fired: ${blocked.flatMap((b) => b.decision.rules).join(', ')}`);

    // ---- 3. Prove it -------------------------------------------------
    console.log('\n3. PROOF — read the chain rather than take our word for it\n');

    const attackerBal = BigInt(
      (await rpc(live.url, 'eth_getBalance', [ATTACKER, 'latest'])) as string,
    );
    const vendorBal = BigInt((await rpc(live.url, 'eth_getBalance', [VENDOR, 'latest'])) as string);
    const nonce = BigInt(
      (await rpc(live.url, 'eth_getTransactionCount', [controller, 'latest'])) as string,
    );
    const height = BigInt((await rpc(live.url, 'eth_blockNumber', [])) as string);

    console.log(
      `   vendor balance     ${formatEther(vendorBal)} BNB   (the allowed transfer landed)`,
    );
    console.log(
      `   attacker balance   ${formatEther(attackerBal)} BNB   (the refused one never existed)`,
    );
    console.log(`   controller nonce   ${nonce}              (one transaction, not two)`);
    console.log(`   chain height       ${height}              (one block mined)`);

    const ok = refused && attackerBal === 0n && nonce === 1n && vendorBal === parseEther('0.05');
    console.log(
      `\n${ok ? '✓ PASS' : '✗ FAIL'} — the refused transaction is on no chain, and cost no gas.\n`,
    );
    if (!ok) process.exitCode = 1;
  } finally {
    await session.close();
    await live.stop();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
