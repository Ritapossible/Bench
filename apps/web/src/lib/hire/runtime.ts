import 'server-only';
import {
  HireOrchestrator,
  InMemoryHireStore,
  type HireRecord,
} from '@bench/services';
import type {
  Address,
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
    return { txHash: `0xsim${Math.random().toString(16).slice(2, 10)}` as Hex, settled: auth.quote.amount, at: new Date() };
  }
  async spentAgainst() {
    return { token: USDT, symbol: 'USDT', decimals: 18, amount: 0n };
  }
}

class SimulatedEscrow implements EscrowClient {
  #jobs = new Map<string, EscrowJob>();
  async openJob(spec: { agent: EscrowJob['agent']; client: Address; amount: TokenAmount; disputeWindowSec: number }) {
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
  async fund(jobId: string) {
    const j = this.#jobs.get(jobId);
    if (j !== undefined) this.#jobs.set(jobId, { ...j, status: 'funded' });
    return `0xfund${jobId.slice(-6)}` as Hex;
  }
  async deliver(jobId: string, proof: Hex) {
    const j = this.#jobs.get(jobId);
    if (j !== undefined) this.#jobs.set(jobId, { ...j, status: 'delivered', deliveryProof: proof });
    return `0xdel${jobId.slice(-6)}` as Hex;
  }
  async settle(jobId: string) {
    const j = this.#jobs.get(jobId);
    if (j !== undefined) this.#jobs.set(jobId, { ...j, status: 'settled' });
    return `0xset${jobId.slice(-6)}` as Hex;
  }
  async dispute(jobId: string) {
    const j = this.#jobs.get(jobId);
    if (j !== undefined) this.#jobs.set(jobId, { ...j, status: 'disputed' });
    return `0xdis${jobId.slice(-6)}` as Hex;
  }
  async get(jobId: string) {
    return this.#jobs.get(jobId) ?? null;
  }
}

/**
 * Module-level so a hire survives between requests on a warm instance.
 *
 * Not durable: a cold start loses it, which is why every read path treats a
 * missing hire as an ordinary outcome and says so rather than erroring.
 * `@bench/db` implements the same `HireStore` interface against Postgres.
 */
const globalForHire = globalThis as unknown as { __benchHire?: { store: InMemoryHireStore; orchestrator: HireOrchestrator } };

function runtime() {
  if (globalForHire.__benchHire === undefined) {
    const store = new InMemoryHireStore();
    globalForHire.__benchHire = {
      store,
      orchestrator: new HireOrchestrator({ payment: new SimulatedPayment(), escrow: new SimulatedEscrow(), store }),
    };
  }
  return globalForHire.__benchHire;
}

export const hireStore = (): InMemoryHireStore => runtime().store;
export const hireOrchestrator = (): HireOrchestrator => runtime().orchestrator;
export type { HireRecord };

/** The demo owner. Replaced by the connected wallet when hiring goes on chain. */
export const DEMO_OWNER = '0x7a16ff8270133f063aab6c9977183d9e72835428' as Address;
export const SETTLEMENT_TOKEN = USDT;
