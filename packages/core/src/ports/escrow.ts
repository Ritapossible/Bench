import type { AgentId } from '../types/agent.js';
import type { EscrowJob } from '../types/hire.js';
import type { Address, Hex, TokenAmount } from '../types/primitives.js';

export interface JobSpec {
  readonly agent: AgentId;
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
  openJob(spec: JobSpec): Promise<EscrowJob>;
  fund(jobId: string): Promise<Hex>;
  deliver(jobId: string, proof: Hex): Promise<Hex>;
  /** Settle after the dispute window closes. */
  settle(jobId: string): Promise<Hex>;
  dispute(jobId: string, reason: string): Promise<Hex>;
  get(jobId: string): Promise<EscrowJob | null>;
}
