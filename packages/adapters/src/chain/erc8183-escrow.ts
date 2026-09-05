import {
  BenchError,
  type Address,
  type ChainName,
  type EscrowClient,
  type EscrowJob,
  type EscrowStatus,
  type Hex,
  type JobSpec,
  type TokenAmount,
} from '@bench/core';
import {
  BNB,
  BNB_TESTNET,
  erc8183Addresses,
  getErc8183Job,
  hireErc8183Agent,
  settleErc8183Job,
  type Erc8183Job,
  type NetworkConfig,
  type Signer,
  type Wallet,
} from '@altananetwork/sdk';

/**
 * ============================================================================
 * ERC-8183 agentic commerce, against the real kernel.
 * ============================================================================
 *
 * Every method here used to throw `notImplemented`, and the checkout ran on an
 * in-process `SimulatedEscrow` holding jobs in a Map. This talks to the
 * AgenticCommerce kernel on BNB Smart Chain: the buyer creates and funds a job
 * in $U, the seller submits a deliverable, and after an optimistic dispute
 * window `settle` releases the escrow.
 *
 * Three things about the kernel the port could not express until now, and that
 * a caller has to know:
 *
 * **Opening a job funds it.** createJob, registerJob, setBudget, approve and
 * fund are one atomic relay intent. There is no unfunded job to reason about,
 * so `fund` confirms the escrow rather than paying into it.
 *
 * **The escrow token is fixed.** The kernel escrows $U at an address it
 * chooses per chain. A caller asking to escrow USDT is asking for something
 * the contract cannot do, and quietly substituting $U would move a different
 * asset than the one the user agreed to. Refused by name.
 *
 * **Delivery is the seller's.** Bench is the buyer, and a buyer that could
 * submit its own deliverable could settle its own escrow.
 */

export interface Erc8183EscrowOptions {
  readonly chain: ChainName;
  /** The buyer's Altana wallet. Escrow is funded from this account. */
  readonly wallet: Wallet;
  /** Admin authority for that wallet. */
  readonly signer: Signer;
  /** Seconds beyond the dispute window the seller gets to submit. */
  readonly deadlineSeconds?: number;
}

/** Kernel status -> the vocabulary the rest of Bench speaks. */
const STATUS: Readonly<Record<string, EscrowStatus>> = {
  OPEN: 'open',
  FUNDED: 'funded',
  SUBMITTED: 'delivered',
  COMPLETED: 'settled',
  REJECTED: 'disputed',
  EXPIRED: 'refunded',
};

const ZERO = '0x0000000000000000000000000000000000000000';

export class Erc8183EscrowClient implements EscrowClient {
  readonly #network: NetworkConfig;
  readonly #opts: Erc8183EscrowOptions;
  /**
   * What each job was opened for, by job id.
   *
   * The kernel stores the budget and the parties but not the `AgentId` the
   * hire was about, and `EscrowJob` carries one. Held rather than re-derived,
   * because mapping a provider address back to a token id is a registry scan
   * that can return more than one answer.
   */
  readonly #opened = new Map<string, { agent: JobSpec['agent']; amount: TokenAmount }>();

  constructor(opts: Erc8183EscrowOptions) {
    this.#network = opts.chain === 'bsc-mainnet' ? BNB : BNB_TESTNET;
    this.#opts = opts;
  }

  /** The $U address this chain's kernel escrows. Not ours to choose. */
  get paymentToken(): Address {
    return erc8183Addresses(this.#network.chainId).paymentToken;
  }

  async openJob(spec: JobSpec): Promise<EscrowJob> {
    const expected = this.paymentToken.toLowerCase();
    if (spec.amount.token.toLowerCase() !== expected) {
      throw new BenchError(
        'INVALID_REQUEST',
        `the ERC-8183 kernel on chain ${this.#network.chainId} escrows $U at ${expected}; this ` +
          `job asked for ${spec.amount.symbol} at ${spec.amount.token.toLowerCase()}. ` +
          `Substituting the escrow token would move a different asset than was agreed.`,
      );
    }
    if (spec.amount.amount <= 0n) {
      throw new BenchError('INVALID_REQUEST', 'escrow budget must be positive');
    }

    const result = await hireErc8183Agent(
      this.#opts.wallet,
      this.#opts.signer,
      {
        provider: spec.provider,
        task: spec.taskSpec,
        budget: spec.amount.amount,
        deadlineSeconds: this.#opts.deadlineSeconds ?? spec.disputeWindowSec,
      },
      { network: this.#network },
    );

    const id = result.jobId.toString();
    this.#opened.set(id, { agent: spec.agent, amount: spec.amount });

    return {
      id,
      agent: spec.agent,
      client: spec.client,
      amount: spec.amount,
      // Funded, not open: the batch that created it also paid into it.
      status: 'funded',
      disputeWindowEndsAt: new Date(Number(result.expiredAt) * 1000),
      deliveryProof: null,
    };
  }

  /**
   * Confirm the escrow holds the money.
   *
   * Sends nothing, so it reports no transaction of its own. Returning a fresh
   * hash would describe a payment that did not happen - the correction the
   * simulated escrow needed when it returned receipts for state changes it had
   * not made.
   */
  async fund(jobId: string): Promise<Hex> {
    const job = await this.#job(jobId);
    if (job.statusName === 'OPEN') {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `ERC-8183 job ${jobId} exists but is not funded; the hire batch did not complete`,
      );
    }
    return `0x${job.id.toString(16).padStart(64, '0')}` as Hex;
  }

  async deliver(_jobId: string, _proof: Hex): Promise<Hex> {
    throw new BenchError(
      'NOT_SUPPORTED_BY_PROVIDER',
      'submitting a deliverable is the seller’s action on ERC-8183. Bench is the buyer, and a ' +
        'buyer that could submit its own deliverable could settle its own escrow.',
    );
  }

  async settle(jobId: string): Promise<Hex> {
    const result = await settleErc8183Job(
      this.#opts.wallet,
      this.#opts.signer,
      { jobId: BigInt(jobId), action: 'approve' },
      { network: this.#network },
    );
    return requireHash(result, `settle ${jobId}`);
  }

  async dispute(jobId: string, reason: string): Promise<Hex> {
    // The kernel takes no reason - the policy is a silence-approves verdict
    // engine and a dispute is a bare state transition. Kept in the signature
    // because Bench records it in the hire's trace, which is the only place a
    // person can read why.
    void reason;
    const result = await settleErc8183Job(
      this.#opts.wallet,
      this.#opts.signer,
      { jobId: BigInt(jobId), action: 'dispute' },
      { network: this.#network },
    );
    return requireHash(result, `dispute ${jobId}`);
  }

  async get(jobId: string): Promise<EscrowJob | null> {
    let job: Erc8183Job;
    try {
      job = await this.#job(jobId);
    } catch (err) {
      if (err instanceof BenchError && err.code === 'NOT_FOUND') return null;
      throw err;
    }

    const known = this.#opened.get(jobId);
    return {
      id: jobId,
      // Unknown when the job was opened by another instance. Reported as token
      // id 0 rather than guessed backwards from the provider address.
      agent: known?.agent ?? { chain: this.#opts.chain, tokenId: 0n },
      client: job.client,
      amount: known?.amount ?? {
        token: this.paymentToken,
        symbol: 'U',
        decimals: 18,
        amount: job.budget,
      },
      status: STATUS[job.statusName] ?? 'open',
      disputeWindowEndsAt: new Date(Number(job.expiredAt) * 1000),
      deliveryProof: isEmptyBytes32(job.deliverable) ? null : job.deliverable,
    };
  }

  async #job(jobId: string): Promise<Erc8183Job> {
    let id: bigint;
    try {
      id = BigInt(jobId);
    } catch {
      throw new BenchError('NOT_FOUND', `${jobId} is not an ERC-8183 job id`);
    }
    const job = await getErc8183Job(this.#network, id);
    // The kernel returns a zeroed struct for an id it never issued.
    if (job.client.toLowerCase() === ZERO) {
      throw new BenchError(
        'NOT_FOUND',
        `no ERC-8183 job ${jobId} on chain ${this.#network.chainId}`,
      );
    }
    return job;
  }
}

const isEmptyBytes32 = (h: Hex): boolean => /^0x0*$/.test(h);

/**
 * The transaction hash, or a refusal.
 *
 * The relay can accept an intent without surfacing a receipt. Treating that as
 * success would record a settled escrow off a payment nobody can point to.
 */
function requireHash(
  result: { status: string; transactionHash?: Hex; callsId: Hex },
  what: string,
): Hex {
  if (result.status === 'FAILED') {
    throw new BenchError('UPSTREAM_UNAVAILABLE', `ERC-8183 ${what} failed (${result.callsId})`);
  }
  if (result.transactionHash === undefined) {
    throw new BenchError(
      'UPSTREAM_UNAVAILABLE',
      `ERC-8183 ${what} was accepted as ${result.callsId} without a transaction hash`,
    );
  }
  return result.transactionHash;
}
