/**
 * Phase 2's exit test, made runnable.
 *
 *   "Three agents auditioned on the same window, three different terminal
 *    states, all replayable from stored parameters."
 *
 *   npm run shadow:demo
 *
 * Requires `anvil` on PATH (or ANVIL_BINARY set). No archive node and no
 * network: the demo runs forkless, which exercises seeding, interception,
 * recording, valuation, the do-nothing baseline and replay — everything except
 * forking from real BSC state.
 *
 * A consequence worth stating plainly, because the output shows it: on a bare
 * chain the only thing that moves value is spending it, so every agent here
 * ends below the baseline. Agents that *gain* need a forked chain carrying
 * PancakeSwap and Venus — that is what the pcs-lp and venus-loan seeders are
 * for, and they decline loudly until they have one.
 */
import { AuditionRunner, type ShadowAgent } from '@bench/services';
import { AnvilForkProvider, controllerFor } from '@bench/adapters';
import type { AuditionWindow, PositionTemplate } from '@bench/core';
import {
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const anvilChain = defineChain({
  id: 31337,
  name: 'anvil',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: [] } },
});

const WINDOW: AuditionWindow = {
  id: 'demo-chop-0801',
  label: 'Chop — 1 Aug 2026',
  regime: 'chop',
  forkBlock: 48_120_000n,
  endBlock: 48_140_000n,
  seed: '0xbe0c11',
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

const walletFor = (rpcUrl: string) =>
  createWalletClient({
    account: privateKeyToAccount(controllerFor(WINDOW.seed).privateKey),
    chain: anvilChain,
    transport: http(rpcUrl),
  });

const SINK = '0x2222222222222222222222222222222222222222' as const;

const agents: ShadowAgent[] = [
  {
    id: 'kestrel',
    name: 'Kestrel LP Rebalancer',
    // Conservative: two small moves.
    async run({ rpcUrl }) {
      const w = walletFor(rpcUrl);
      for (let i = 0; i < 2; i += 1) {
        await w.sendTransaction({ to: SINK, value: parseEther('0.05') });
      }
    },
  },
  {
    id: 'hollow-grid',
    name: 'Hollow Grid v2',
    // Aggressive: many moves, and the gas adds up.
    async run({ rpcUrl }) {
      const w = walletFor(rpcUrl);
      for (let i = 0; i < 10; i += 1) {
        await w.sendTransaction({ to: SINK, value: parseEther('0.08') });
      }
    },
  },
  {
    id: 'aegis',
    name: 'Aegis Swap Router',
    // Approvals only: recognisable calldata, no value moved but gas spent.
    async run({ rpcUrl }) {
      const w = walletFor(rpcUrl);
      for (let i = 0; i < 3; i += 1) {
        await w.sendTransaction({
          to: '0x3333333333333333333333333333333333333333',
          data: encodeFunctionData({
            abi: parseAbi(['function approve(address spender, uint256 amount)']),
            args: [SINK, BigInt(i + 1) * 10n ** 18n],
          }),
        });
      }
    },
  },
];

const usd = (n: number) => `$${n.toFixed(2)}`;
const signed = (n: number) => `${n < 0 ? '−' : '+'}$${Math.abs(n).toFixed(2)}`;
const pad = (s: string, n: number) => s.padEnd(n);
const padL = (s: string, n: number) => s.padStart(n);

async function main(): Promise<void> {
  const provider = new AnvilForkProvider({ forkless: true, chainId: 31337 });
  const runner = new AuditionRunner({ forks: provider });

  console.log(`\nWindow   ${WINDOW.label}  (${WINDOW.regime}, fork block ${WINDOW.forkBlock})`);
  console.log(`Position ${POSITION.label}`);
  console.log(`Replay   ${provider.replayHash(WINDOW)}\n`);

  const report = await runner.run({
    window: WINDOW,
    position: POSITION,
    agents,
    archiveRpcUrl: 'forkless',
    maxConcurrentForks: 3,
  });

  console.log(
    `${pad('AGENT', 26)}${padL('ACTIONS', 9)}${padL('TERMINAL', 13)}${padL('VS DO-NOTHING', 16)}`,
  );
  console.log('─'.repeat(64));
  console.log(
    `${pad('Do nothing (baseline)', 26)}${padL('0', 9)}${padL(usd(report.doNothing.valueUsd), 13)}${padL(signed(0), 16)}`,
  );

  for (const r of [...report.results].sort(
    (a, b) => b.deltaVsDoNothingUsd - a.deltaVsDoNothingUsd,
  )) {
    console.log(
      `${pad(r.agentName, 26)}${padL(String(r.actions.length), 9)}${padL(usd(r.terminal.valueUsd), 13)}${padL(signed(r.deltaVsDoNothingUsd), 16)}`,
    );
  }

  console.log('─'.repeat(64));
  console.log(`peer median ${usd(report.peerMedianUsd ?? 0)}\n`);

  const distinct = new Set(report.results.map((r) => r.terminal.valueUsd.toFixed(6)));
  console.log(`Distinct terminal states: ${distinct.size} of ${report.results.length}`);

  const decoded = report.results.flatMap((r) => r.actions).filter((a) => a.decoded !== null);
  console.log(
    `Intercepted actions: ${report.results.reduce((n, r) => n + r.actions.length, 0)} (${decoded.length} decoded by name)`,
  );

  // Replay: same window, same seed, same agent — same terminal state, or the
  // record is not reproducible and is worth nothing.
  console.log('\nReplaying Kestrel from stored parameters…');
  const replay = await runner.run({
    window: WINDOW,
    position: POSITION,
    agents: [agents[0]!],
    archiveRpcUrl: 'forkless',
  });

  const before = report.results.find((r) => r.agentId === 'kestrel')!.terminal.valueUsd;
  const after = replay.results[0]!.terminal.valueUsd;
  const matches = before.toFixed(6) === after.toFixed(6);

  console.log(`  original ${usd(before)}`);
  console.log(`  replay   ${usd(after)}`);
  console.log(`  replay hash matches: ${replay.replayHash === report.replayHash}`);
  console.log(
    `\n${matches ? '✓ PASS' : '✗ FAIL'} — audition is reproducible from its stored parameters.\n`,
  );

  if (!matches) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
