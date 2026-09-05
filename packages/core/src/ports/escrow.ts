import type { AgentId } from '../types/agent.js';
import type { EscrowJob } from '../types/hire.js';
import type { Address, Hex, TokenAmount } from '../types/primitives.js';

export interface JobSpec {
  readonly agent: AgentId;
  /**
   * The seller's payout address - the ERC-8004 identity holder.
   *
   * Carried separately from `agent` because the kernel escrows to an address
   * and an `AgentId` is a chain plus a token id, which is not one. Deriving it
   * inside the adapter would put a registry read on the settlement path and
   * make the caller's intent depend on a lookup that can fail.
   */
  readonly provider: Address;
  readonly client: Address;
  readonly amount: TokenAmount;
  /** Task description hashed onchain; full text stays off-chain. */
  readonly taskSpec: string;
  readonly disputeWindowSec: number;
}

/**
 * ERC-8183 agentic commerce: AgenticCommerce kernel + EvaluatorRouter +
 * OptimisticPolicy. Optimistic settlement — silence past the dispute window is
 * implicit approval; the client may dispute within it to trigger a
 * whitelisted-voter quorum.
 *
 * Live on BSC testnet; mainnet pending as of Aug 2026. Confirm the judging
 * target with the organizers before assuming mainnet.
 */
export interface EscrowClient {
  /**
   * Create the job. On ERC-8183 this also funds it.
   *
   * The kernel has no unfunded-open state: createJob, registerJob, setBudget,
   * approve and fund are one atomic batch, and a job that exists is a job with
   * money behind it. `fund` below therefore confirms rather than pays - stated
   * here because a caller reading the two names would otherwise reasonably
   * expect the money to move on the second one.
   */
  openJob(spec: JobSpec): Promise<EscrowJob>;
  /** Confirm the escrow is funded. Idempotent; never a second payment. */
  fund(jobId: string): Promise<Hex>;
  /**
   * Record a deliverable. The **seller's** action, not the buyer's.
   *
   * Bench hires; it does not deliver. An adapter for a real kernel refuses
   * this rather than implementing it, because a buyer that could submit its
   * own deliverable could settle its own escrow.
   */
  deliver(jobId: string, proof: Hex): Promise<Hex>;
  /** Settle after the dispute window closes. */
  settle(jobId: string): Promise<Hex>;
  dispute(jobId: string, reason: string): Promise<Hex>;
  get(jobId: string): Promise<EscrowJob | null>;
}
