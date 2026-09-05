import 'server-only';
import { HireOrchestrator, InMemoryHireStore } from '@bench/services';
import { createDb, PgHireStore } from '@bench/db';
import { Erc8183EscrowClient } from '@bench/adapters';
import { signerFromPrivateKey } from '@altananetwork/sdk';
import { BenchError } from '@bench/core';
import type {
  Address,
  HireRecord,
  HireStore,
  EscrowClient,
  EscrowJob,
  Hex,
  PaymentClient,
  TokenAmount,
} from '@bench/core';

/**
 * Server-side hire runtime for this deployment.
 *
 * The orchestrator, mandate, consent checklist, decision trace and both bounds
 * are the real implementations from `@bench/services` and `@bench/core` - this
 * module supplies only the two adapters that are still stubs upstream, so the
 * journey the contest scores ("land, find an agent by category, understand what
 * it does, activate it") can actually be completed end to end.
 *
 * They are labelled everywhere they surface. Swapping in X402PaymentClient and
 * Erc8183EscrowClient replaces this file and nothing else.
 */

const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;

class SimulatedPayment implements PaymentClient {
  /**
   * What this simulation has "settled", per payee.
   *
   * `spentAgainst` returned a hardcoded zero, so any cumulative-spend check
   * reading it could never trip - a cap that is structurally unreachable reads
   * as a cap that is never exceeded. Tracking it keeps the simulation's own
   * arithmetic honest even though no real money moves.
   */
  #settled = new Map<string, bigint>();

  async quote(req: { readonly payTo: Address; readonly amount: TokenAmount }) {
    return {
      payTo: req.payTo,
      amount: req.amount,
      scheme: 'permit2-upto' as const,
      expiresAt: new Date(Date.now() + 15 * 60_000),
      nonce: `0x${Math.random().toString(16).slice(2, 10)}` as Hex,
    };
  }
  async authorize(quote: Awaited<ReturnType<SimulatedPayment['quote']>>) {
    return { quote, signature: '0xsimulated' as Hex, ceiling: quote.amount };
  }
  async settle(auth: Awaited<ReturnType<SimulatedPayment['authorize']>>) {
    const key = auth.quote.payTo.toLowerCase();
    this.#settled.set(key, (this.#settled.get(key) ?? 0n) + auth.quote.amount.amount);
    return {
      txHash: `0xsim${Math.random().toString(16).slice(2, 10)}` as Hex,
      settled: auth.quote.amount,
      at: new Date(),
    };
  }
  async spentAgainst(auth: Awaited<ReturnType<SimulatedPayment['authorize']>>) {
    return {
      token: USDT,
      symbol: 'USDT',
      decimals: 18,
      amount: this.#settled.get(auth.quote.payTo.toLowerCase()) ?? 0n,
    };
  }
}

class SimulatedEscrow implements EscrowClient {
  #jobs = new Map<string, EscrowJob>();
  async openJob(spec: {
    agent: EscrowJob['agent'];
    client: Address;
    amount: TokenAmount;
    disputeWindowSec: number;
  }) {
    const job: EscrowJob = {
      id: `job_${Math.random().toString(36).slice(2, 10)}`,
      agent: spec.agent,
      client: spec.client,
      amount: spec.amount,
      status: 'open',
      disputeWindowEndsAt: new Date(Date.now() + spec.disputeWindowSec * 1_000),
      deliveryProof: null,
    };
    this.#jobs.set(job.id, job);
    return job;
  }
  /**
   * Jobs live in this instance's memory while `escrowJobId` is persisted, so a
   * request served by a different instance - or after a restart - reaches a job
   * this map has never seen. Returning a transaction hash for it reported a
   * state change that did not happen, which is worse than failing: the hire
   * record would say "funded" on the strength of a receipt for nothing.
   */
  #require(jobId: string): EscrowJob {
    const j = this.#jobs.get(jobId);
    if (j === undefined) {
      throw new BenchError(
        'NOT_FOUND',
        `escrow job ${jobId} is not held by this instance. Simulated escrow is per-process; ` +
          `a real EscrowClient reads it from the chain.`,
      );
    }
    return j;
  }

  async fund(jobId: string) {
    this.#jobs.set(jobId, { ...this.#require(jobId), status: 'funded' });
    return `0xfund${jobId.slice(-6)}` as Hex;
  }
  async deliver(jobId: string, proof: Hex) {
    this.#jobs.set(jobId, { ...this.#require(jobId), status: 'delivered', deliveryProof: proof });
    return `0xdel${jobId.slice(-6)}` as Hex;
  }
  async settle(jobId: string) {
    this.#jobs.set(jobId, { ...this.#require(jobId), status: 'settled' });
    return `0xset${jobId.slice(-6)}` as Hex;
  }
  async dispute(jobId: string) {
    this.#jobs.set(jobId, { ...this.#require(jobId), status: 'disputed' });
    return `0xdis${jobId.slice(-6)}` as Hex;
  }
  async get(jobId: string) {
    return this.#jobs.get(jobId) ?? null;
  }
}

/**
 * The ERC-8183 kernel, when this deployment is configured to settle on chain.
 *
 * Null without an admin key, and that is the honest default rather than a
 * degraded one: real escrow moves real $U from an account whose key this
 * process holds, and a deployment should opt into that deliberately. The
 * checkout says which one it is using, so the difference is never silent.
 *
 * `BENCH_ESCROW_ENABLED` gates it separately from the key because the key has
 * other uses - probe anchoring reads the same variable - and enabling escrow
 * as a side effect of enabling anchoring is not a decision anybody made.
 */
function realEscrow(): EscrowClient | null {
  const key = process.env['BENCH_SIGNER_PRIVATE_KEY'];
  if (process.env['BENCH_ESCROW_ENABLED'] !== 'true') return null;
  if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.warn(
      '[bench] BENCH_ESCROW_ENABLED is set but BENCH_SIGNER_PRIVATE_KEY is missing or malformed - ' +
        'the checkout will keep using simulated escrow.',
    );
    return null;
  }

  const signer = signerFromPrivateKey(key as `0x${string}`);
  return new Erc8183EscrowClient({
    chain: (process.env['BENCH_CHAIN'] as 'bsc-mainnet' | 'bsc-testnet') ?? 'bsc-testnet',
    // The 7702 account address is the admin EOA's, so this needs no round trip.
    wallet: { address: signer.address },
    signer,
  });
}

/** True when the checkout settles on chain rather than in memory. */
export const escrowIsReal = (): boolean => realEscrow() !== null;

/**
 * The store, chosen the same way `lib/data` chooses its catalog source.
 *
 * With `DATABASE_URL` set, hires are rows in Postgres: they survive a restart,
 * they are visible to every instance, and - the part that actually matters -
 * two concurrent requests carrying the same idempotency key contend on a unique
 * index rather than on two copies of a Map that cannot see each other. A hire
 * moves money, so "at most once" has to be enforced somewhere both requests can
 * reach, and process memory is not that place.
 *
 * Without it, an in-memory store, so a fresh clone runs with no database. That
 * fallback loses hires on a cold start, which is why every read path treats a
 * missing hire as an ordinary outcome and says so rather than erroring.
 */
const globalForHire = globalThis as unknown as {
  __benchHire?: { store: HireStore; orchestrator: HireOrchestrator; durable: boolean };
};

function runtime() {
  if (globalForHire.__benchHire === undefined) {
    const url = process.env['DATABASE_URL'];
    const durable = url !== undefined && url.trim() !== '';
    const store: HireStore = durable ? new PgHireStore(createDb(url)) : new InMemoryHireStore();

    if (!durable && process.env['NODE_ENV'] === 'production') {
      console.warn(
        '[bench] DATABASE_URL is not set - hires are IN MEMORY and will be lost on restart, ' +
          'and idempotency cannot be enforced across instances.',
      );
    }

    globalForHire.__benchHire = {
      store,
      durable,
      orchestrator: new HireOrchestrator({
        payment: new SimulatedPayment(),
        escrow: realEscrow() ?? new SimulatedEscrow(),
        store,
      }),
    };
  }
  return globalForHire.__benchHire;
}

export const hireStore = (): HireStore => runtime().store;
export const hireOrchestrator = (): HireOrchestrator => runtime().orchestrator;
/** True when hires are persisted. Read by /hires, which says so on the page. */
export const hiresAreDurable = (): boolean => runtime().durable;
export type { HireRecord };

export const SETTLEMENT_TOKEN = USDT;
