import type { RecordedAction } from '../types/dispute.js';
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
  /**
   * The actions the gate admitted, in the shape the arbiter replays.
   *
   * Separate from `trace` rather than derived from it, and the distinction is
   * the point. The trace is every decision, refusals included, hash-chained so
   * nobody can rewrite what Bench decided. The record is what actually
   * happened - and a refused proposal did not happen, so replaying it would
   * manufacture a breach out of the gate working correctly.
   *
   * Optional because hires created before this existed have none, and a record
   * that is absent is honestly absent: the arbiter answers `unresolved` on a
   * record it cannot read rather than clearing the agent.
   */
  readonly actions?: readonly RecordedAction[];
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
  /**
   * Move every hire from one owner to another. Returns how many moved.
   *
   * Exists for exactly one moment: a visitor who hired anonymously and then
   * connected a wallet. Without it, connecting looks like losing everything -
   * the hires are still there, under an id the session has just stopped using -
   * which is a worse first impression than never offering the wallet at all.
   *
   * Deliberately not a general-purpose transfer. The caller has proved control
   * of `to` with a signature and holds `from` in its own signed cookie, so it
   * is moving hires between two identities the same person demonstrably has.
   */
  reassign(from: Address, to: Address): Promise<number>;
}
