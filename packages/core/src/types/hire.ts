import type { AgentId } from './agent.js';
import type { Address, Hex, TokenAmount } from './primitives.js';

/**
 * Authority granted to a hired agent: an EIP-7702 session key scoped to a
 * spend cap and a contract allowlist, revocable by the user at any time.
 * Altana track requirement, and the safety story for the whole product.
 */
export interface SessionKeyGrant {
  readonly id: string;
  readonly key: Address;
  readonly owner: Address;
  readonly spendCap: TokenAmount;
  readonly spent: TokenAmount;
  readonly contractAllowlist: readonly Address[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type X402Scheme = 'eip3009' | 'permit2-exact' | 'permit2-upto';

export interface PaymentQuote {
  readonly payTo: Address;
  readonly amount: TokenAmount;
  readonly scheme: X402Scheme;
  readonly expiresAt: Date;
  readonly nonce: Hex;
}

export interface PaymentAuthorization {
  readonly quote: PaymentQuote;
  readonly signature: Hex;
  /** For permit2-upto: the ceiling. Draws meter against it over the job. */
  readonly ceiling: TokenAmount | null;
}

export interface PaymentReceipt {
  readonly txHash: Hex;
  readonly settled: TokenAmount;
  readonly at: Date;
}

/** ERC-8183 optimistic settlement: silence past the window is approval. */
export type EscrowStatus =
  | 'open'
  | 'funded'
  | 'delivered'
  | 'disputed'
  | 'settled'
  | 'refunded';

export interface EscrowJob {
  readonly id: string;
  readonly agent: AgentId;
  readonly client: Address;
  readonly amount: TokenAmount;
  readonly status: EscrowStatus;
  readonly disputeWindowEndsAt: Date | null;
  readonly deliveryProof: Hex | null;
}

export type HireStatus = 'pending' | 'active' | 'completed' | 'revoked' | 'failed';

export interface Hire {
  readonly id: string;
  readonly user: Address;
  readonly agents: readonly AgentId[];
  readonly escrowJobId: string | null;
  readonly sessionKeyId: string | null;
  readonly status: HireStatus;
  readonly createdAt: Date;
  /** Set when hired through the broker agent from a natural-language intent. */
  readonly brokerIntent: string | null;
}

/**
 * Feedback is payment-gated: it counts only when bound to a settled escrow job
 * of nonzero value, then weighted by payment size and the payer's own settled
 * history. This is the direct answer to the ~59% Sybil-reviewer finding — it
 * makes review farming cost real money and scale sub-linearly with the payoff.
 */
export interface Feedback {
  readonly hireId: string;
  readonly escrowJobId: string;
  readonly rating: number;
  readonly comment: string | null;
  readonly weight: number;
  readonly settledValueUsd: number;
}
