import type { AgentId } from '../types/agent.js';
import type { BehaviouralEnvelope, EnvelopePolicy } from '../types/envelope.js';
import type { HireState, TraceEntry } from '../types/hire-flow.js';
import type { HireMandate, MandateState } from '../types/mandate.js';
import type { Address, Hex } from '../types/primitives.js';

/**
 * Where hires live - ARCHITECTURE.md 3.6.
 *
 * A port rather than a class because the two implementations differ in the one
 * property that matters: `InMemoryHireStore` in @bench/services can only
 * arbitrate within a single process, and `PgHireStore` in @bench/db arbitrates
 * across every instance. The orchestrator is written against this interface so
 * that difference is a deployment choice rather than a rewrite.
 */

export interface HireRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: HireState;
  readonly owner: Address;
  readonly agent: AgentId;
  readonly mandate: HireMandate;
  /**
   * The owner's signature over the mandate digest, when one was supplied.
   *
   * Null is a fact the UI must show, not hide: an unsigned mandate is bounds
   * the owner picked but never cryptographically authorised, which is a weaker
   * claim than "signed" and has to read as one.
   */
  readonly mandateSignature: { readonly signature: Hex; readonly signer: Address } | null;
  readonly mandateState: MandateState;
  readonly envelope: BehaviouralEnvelope;
  readonly envelopePolicy: EnvelopePolicy | undefined;
  readonly escrowJobId: string | null;
  readonly paymentTxHash: Hex | null;
  readonly trace: readonly TraceEntry[];
  readonly createdAt: Date;
  readonly failureReason?: string;
}

/**
 * The outcome of trying to take ownership of an idempotency key.
 *
 * `claimed` is the only thing that licenses the caller to spend money. A loser
 * still gets a `record` - the winner's - so a retried hire request is answered
 * with the real hire rather than an error.
 */
export interface ClaimResult {
  readonly claimed: boolean;
  readonly record: HireRecord;
}

export interface HireStore {
  /**
   * Insert `record` **iff** its idempotency key is unclaimed, atomically.
   *
   * This is the load-bearing method of the whole interface. Read-then-write
   * dedupe - `byIdempotencyKey` returning null, then `put` - is a TOCTOU race:
   * two concurrent requests both miss and both charge. Implementations must
   * resolve the contention in one operation, in the place where the two
   * requests actually meet. For Postgres that is `INSERT ... ON CONFLICT DO
   * NOTHING`; application memory is not shared across instances and so cannot
   * arbitrate at all.
   */
  claim(record: HireRecord): Promise<ClaimResult>;
  byIdempotencyKey(key: string): Promise<HireRecord | null>;
  get(id: string): Promise<HireRecord | null>;
  /** Update an already-claimed hire. Never creates: a hire exists only via `claim`. */
  put(record: HireRecord): Promise<void>;
  listByOwner(owner: Address): Promise<readonly HireRecord[]>;
}
