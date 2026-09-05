/**
 * A real hire, settled on the ERC-8183 kernel.
 *
 * Runs the actual `HireOrchestrator` - the same consent checklist, mandate,
 * behavioural envelope, decision trace and idempotency the checkout uses -
 * with `Erc8183EscrowClient` in place of the in-memory simulation. So what
 * this proves is not "the adapter compiles" but "a hire opened, funded and
 * recorded a real escrow, and the domain refused everything it should have".
 *
 *   BENCH_SIGNER_PRIVATE_KEY=0x… npx tsx scripts/hire-e2e-onchain.mts
 *
 * The buyer needs test BNB for gas and $U for the budget. See the README.
 */
import { CONSENT_STEPS, deriveEnvelope, type Address, type ConsentStep } from '@bench/core';
import { Erc8183EscrowClient } from '@bench/adapters';
import { HireOrchestrator, InMemoryHireStore } from '@bench/services';
import { signerFromPrivateKey, BNB_TESTNET, erc8183Addresses } from '@altananetwork/sdk';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';

const KEY = process.env['BENCH_SIGNER_PRIVATE_KEY'];
if (KEY === undefined || !/^0x[0-9a-fA-F]{64}$/.test(KEY)) {
  console.error('BENCH_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
  process.exit(1);
}

/** Stands in for a seller. It never delivers, which is itself worth showing. */
const PROVIDER = '0x000000000000000000000000000000000000dEaD' as Address;
const BUDGET = 10n ** 18n; // 1 $U

async function main(): Promise<void> {
  const signer = signerFromPrivateKey(KEY as `0x${string}`);
  const buyer = signer.address as Address;
  const kernel = erc8183Addresses(BNB_TESTNET.chainId);
  const pub = createPublicClient({ transport: http(BNB_TESTNET.publicRpcUrl) });
  const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

  const balanceOf = async (who: Address) =>
    pub.readContract({
      address: kernel.paymentToken,
      abi: erc20,
      functionName: 'balanceOf',
      args: [who],
    });

  console.log(`buyer            ${buyer}`);
  console.log(`kernel           ${kernel.commerce}`);
  console.log(`$U before        ${formatUnits(await balanceOf(buyer), 18)}`);

  const escrow = new Erc8183EscrowClient({
    chain: 'bsc-testnet',
    wallet: { address: buyer },
    signer,
  });

  // Payment stays simulated: x402 is merchant-driven and cannot pay a chosen
  // party a chosen amount, which is what a hire is. Escrow is the real half.
  const payment = {
    async quote(r: { payTo: Address; amount: unknown }) {
      return {
        payTo: r.payTo,
        amount: r.amount,
        scheme: 'permit2-upto',
        expiresAt: new Date(Date.now() + 9e5),
        nonce: '0x00',
      };
    },
    async authorize(q: unknown) {
      return { quote: q, signature: '0xsimulated', ceiling: null };
    },
    async settle(a: { quote: { amount: unknown } }) {
      return { txHash: '0xsimulated', settled: a.quote.amount, at: new Date() };
    },
    async spentAgainst(a: { quote: { amount: { token: Address } } }) {
      return { token: a.quote.amount.token, symbol: 'U', decimals: 18, amount: 0n };
    },
  };

  const store = new InMemoryHireStore();
  const orchestrator = new HireOrchestrator({ payment: payment as never, escrow, store });

  const u = (amount: bigint) => ({ token: kernel.paymentToken, symbol: 'U', decimals: 18, amount });

  const request = {
    idempotencyKey: `onchain-${Date.now()}`,
    owner: buyer,
    agent: { chain: 'bsc-testnet' as const, tokenId: 1581n },
    bounds: {
      totalSpendCap: u(5n * 10n ** 18n),
      perTxCap: u(10n ** 18n),
      contractAllowlist: [kernel.commerce],
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      maxActions: 20,
    },
    consent: [...CONSENT_STEPS] as ConsentStep[],
    taskSpec: 'Bench end-to-end escrow proof',
    price: u(BUDGET),
    payTo: PROVIDER,
    disputeWindowSec: 3600,
    envelope: deriveEnvelope([]),
  };

  // The domain's own refusal, before any money moves.
  console.log('\n--- incomplete consent is refused ---');
  try {
    await orchestrator.hire({ ...request, idempotencyKey: 'partial', consent: ['set-spend-cap'] });
    console.log('  NOT REFUSED - that is a bug');
  } catch (err) {
    console.log(`  refused: ${(err as Error).message.slice(0, 90)}`);
  }

  console.log('\n--- the real hire ---');
  const record = await orchestrator.hire(request);
  console.log(`  hire           ${record.id}`);
  console.log(`  state          ${record.state}`);
  console.log(`  escrow job     ${record.escrowJobId}`);

  const job = record.escrowJobId === null ? null : await escrow.get(record.escrowJobId);
  console.log(`  job status     ${job?.status}`);
  console.log(`  job budget     ${job === null ? '-' : formatUnits(job.amount.amount, 18)} $U`);
  console.log(`  dispute ends   ${job?.disputeWindowEndsAt?.toISOString()}`);
  console.log(`$U after         ${formatUnits(await balanceOf(buyer), 18)}`);
  console.log(`kernel holds     ${formatUnits(await balanceOf(kernel.commerce), 18)} $U`);

  console.log('\n--- settling before the seller delivered is refused by the kernel ---');
  try {
    await escrow.settle(record.escrowJobId ?? '0');
    console.log('  NOT REFUSED - that is a bug');
  } catch (err) {
    console.log(`  refused: ${(err as Error).message.slice(0, 110)}`);
  }

  console.log('\n--- the trace, which is what a reader audits ---');
  for (const entry of record.trace) {
    console.log(
      `  ${entry.step.padEnd(12)} ${entry.outcome.padEnd(8)} ${entry.detail.slice(0, 70)}`,
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
