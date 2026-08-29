import { randomBytes } from 'node:crypto';
import {
  appendTrace,
  applySpend,
  assertTransition,
  BenchError,
  checkAgainstEnvelope,
  checkMandate,
  isMandateSignedBy,
  consentComplete,
  formatBaseUnits,
  formatTokenAmount,
  mandateDigest,
  revoke as revokeState,
  EMPTY_MANDATE_STATE,
  type Address,
  type AgentId,
  type BehaviouralEnvelope,
  type CandidateAction,
  type ConsentStep,
  type EnvelopePolicy,
  type ClaimResult,
  type EscrowClient,
  type HireMandate,
  type HireRecord,
  type HireState,
  type HireStore,
  type Hex,
  type MandateBounds,
  type SignedMandate,
  type PaymentClient,
  type TokenAmount,
  type TraceEntry,
} from '@bench/core';

/**
 * The hire pipeline — ARCHITECTURE.md 3.6.
 *
 * Composes payment, escrow, the mandate and the gate into one lifecycle, and
 * is written for production rather than for a demo path. Four properties it
 * exists to guarantee:
 *
 *   1. **Idempotent.** A retried hire request returns the original hire. Money
 *      moves at most once per idempotency key, whatever the client does.
 *   2. **Consent before money.** No quote is paid and no escrow is opened until
 *      the ordered consent checklist is complete.
 *   3. **Every step traced.** Success and failure both append to a hash-chained
 *      decision trace, so "why did my agent do that" has an answer that cannot
 *      be edited afterwards.
 *   4. **Failure is a state, not an exception that escapes.** A partial failure
 *      lands in `failed` with the reason in the trace, rather than leaving a
 *      hire wedged between states.
 */

export type { ClaimResult, HireRecord, HireStore } from '@bench/core';

/** 32 bytes of CSPRNG. `Math.random` is not one and a nonce is replay protection. */
const randomNonce = (): Hex => `0x${randomBytes(32).toString('hex')}` as Hex;

export interface HireRequest {
  /** Same key ⇒ same hire. The client generates it; the server trusts it only for dedupe. */
  readonly idempotencyKey: string;
  readonly owner: Address;
  readonly agent: AgentId;
  readonly bounds: MandateBounds;
  readonly consent: readonly ConsentStep[];
  readonly taskSpec: string;
  readonly price: TokenAmount;
  readonly payTo: Address;
  readonly disputeWindowSec: number;
  /**
   * The agent's behavioural envelope **as of now**.
   *
   * Snapshotted onto the hire rather than re-derived per transaction, and that
   * is a security property rather than a caching decision: an envelope
   * recomputed live could be widened by the agent auditioning differently
   * after it was hired. The bound is what it had demonstrated when you agreed
   * to it.
   */
  readonly envelope: BehaviouralEnvelope;
  readonly envelopePolicy?: EnvelopePolicy;
  /** The session key the mandate authorises. Defaults to the owner. */
  readonly sessionKey?: Address;
  /**
   * The owner's signature over the mandate digest, with the address that
   * produced it.
   *
   * Optional because this deployment cannot yet mint a session key or prompt a
   * wallet, and refusing every hire would be worse than proceeding with the
   * fact recorded. When present it is verified before any money moves, and the
   * hire records that it was; when absent the hire is marked unsigned and the
   * UI says so rather than describing it as authorised.
   */
  readonly signature?: { readonly signature: Hex; readonly signer: Address };
}

export interface HireOrchestratorDeps {
  readonly payment: PaymentClient;
  readonly escrow: EscrowClient;
  readonly store: HireStore;
  readonly clock?: () => Date;
  readonly ids?: () => string;
}

/**
 * A transaction put to the gate.
 *
 * Deliberately a subset of `CandidateAction`: the two history fields that type
 * carries (`cumulativeValueWei`, `priorActionCount`) are filled by the
 * orchestrator from persisted state, so there is no way for a caller to state
 * its own spending history and no way to forget to.
 */
export type ProposedAction = Omit<CandidateAction, 'cumulativeValueWei' | 'priorActionCount'> & {
  readonly token: Address;
};

/** Combined verdict from both independent bounds. */
export interface ActionDecision {
  readonly allowed: boolean;
  readonly rules: readonly string[];
  readonly explanation: string;
  /** True when the envelope was too thin to enforce and only the mandate bound applied. */
  readonly envelopeAdvisory: boolean;
}

export class HireOrchestrator {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: HireOrchestratorDeps) {
    this.now = deps.clock ?? (() => new Date());
    // CSPRNG, not Math.random. Hire ids address a mandate and its full
    // decision trace, and V8's PRNG state is recoverable from its outputs -
    // which made them enumerable rather than merely unguessed.
    this.newId = deps.ids ?? (() => `h_${randomBytes(12).toString('hex')}`);
  }

  /**
   * Create a hire: quote → authorize → fund → active.
   *
   * Returns the existing hire unchanged if the idempotency key has been seen,
   * *including* when that hire failed — retrying a failed charge is the
   * client's decision to make with a new key, not something to do silently.
   */
  async hire(req: HireRequest): Promise<HireRecord> {
    if (!consentComplete(req.consent)) {
      throw new BenchError(
        'NOT_SUPPORTED_BY_PROVIDER',
        'consent is incomplete; every bound must be confirmed before a hire is created',
      );
    }

    const at = this.now();
    const id = this.newId();
    const mandate: HireMandate = {
      id: `mnd_${id}`,
      version: 1,
      hireId: id,
      owner: req.owner,
      agent: req.agent,
      // Until session keys are minted on chain the owner is the authorised
      // signer, and that is stated rather than disguised: a mandate whose
      // sessionKey is the owner authorises the owner, and the UI says so.
      sessionKey: req.sessionKey ?? req.owner,
      bounds: req.bounds,
      // Real hex. This used to be `0x${id}` over an opaque id like `h_a1b2c3`,
      // producing `0xh_a1b2c3` - typed Hex, not hex, and unusable anywhere a
      // nonce actually has to be one.
      nonce: randomNonce(),
      issuedAt: at,
    };

    // Verify before anything external happens. An invalid signature is a
    // refusal, not a warning: proceeding would let a mandate claim an
    // authorisation it does not have.
    if (req.signature !== undefined) {
      const signed: SignedMandate = {
        mandate,
        signature: req.signature.signature,
        signer: req.signature.signer,
      };
      if (!isMandateSignedBy(signed, req.signature.signer)) {
        throw new BenchError(
          'NOT_SUPPORTED_BY_PROVIDER',
          'the mandate signature does not authorise this owner',
        );
      }
    }

    let record: HireRecord = {
      id,
      idempotencyKey: req.idempotencyKey,
      state: 'draft',
      owner: req.owner,
      agent: req.agent,
      mandate,
      mandateSignature: req.signature ?? null,
      mandateState: EMPTY_MANDATE_STATE,
      envelope: req.envelope,
      envelopePolicy: req.envelopePolicy,
      escrowJobId: null,
      paymentTxHash: null,
      trace: [],
      createdAt: at,
    };

    // Claim before anything external happens. This single call does double
    // duty: it persists the draft, so a crash mid-flight leaves a record to
    // reconcile rather than a charge with no hire attached, and it decides who
    // owns the idempotency key. Losing the claim returns the winner's hire and
    // spends nothing.
    record = this.#trace(
      record,
      'consent',
      'ok',
      [],
      `consent complete; mandate ${mandateDigest(mandate)}`,
    );
    const claim = await this.deps.store.claim(record);
    if (!claim.claimed) return claim.record;
    record = claim.record;

    try {
      const quote = await this.deps.payment.quote({
        resource: `agent:${req.agent.chain}:${req.agent.tokenId.toString()}`,
        payTo: req.payTo,
        amount: req.price,
      });
      record = this.#advance(
        record,
        'quoted',
        'quote',
        `quoted ${formatTokenAmount(quote.amount)}`,
      );
      await this.deps.store.put(record);

      const auth = await this.deps.payment.authorize(quote);
      record = this.#advance(record, 'authorized', 'authorize', `authorized under ${quote.scheme}`);
      await this.deps.store.put(record);

      const job = await this.deps.escrow.openJob({
        agent: req.agent,
        client: req.owner,
        amount: req.price,
        taskSpec: req.taskSpec,
        disputeWindowSec: req.disputeWindowSec,
      });
      const fundTx = await this.deps.escrow.fund(job.id);
      const receipt = await this.deps.payment.settle(auth);

      record = {
        ...this.#advance(record, 'funded', 'fund', `escrow ${job.id} funded (${fundTx})`),
        escrowJobId: job.id,
        paymentTxHash: receipt.txHash,
      };
      await this.deps.store.put(record);

      record = this.#advance(
        record,
        'active',
        'mint-session-key',
        `session key scoped to mandate ${mandate.id}`,
      );
      await this.deps.store.put(record);
      return record;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const failed: HireRecord = {
        ...this.#trace(record, 'submit', 'failed', [], `hire failed: ${reason}`),
        state: 'failed',
        failureReason: reason,
      };
      await this.deps.store.put(failed);
      return failed;
    }
  }

  /**
   * The signing gate: a transaction must clear **both** independent bounds.
   *
   * The mandate answers "did the owner authorise this?"; the envelope answers
   * "has this agent ever done this?". Neither subsumes the other, so both are
   * evaluated and every rule that fired is reported — a refusal should be
   * complete rather than stopping at the first reason.
   *
   * The candidate describes **only the transaction**. How much this agent has
   * already moved and how many actions it has already taken come from the
   * persisted mandate state, never from the caller, and that is a security
   * property rather than a convenience. An envelope whose cumulative bounds are
   * evaluated against numbers the caller supplies is not a bound at all: a
   * caller passing zero every time — a bug, or an agent that would rather not
   * be stopped — silently disables the cumulative-value and action-count rules
   * while the gate keeps reporting that it enforced them. Both bounds now read
   * the same recorded history, which is the only version either can trust.
   */
  async authorizeAction(hireId: string, candidate: ProposedAction): Promise<ActionDecision> {
    const record = await this.#require(hireId);

    if (record.state !== 'active') {
      const decision: ActionDecision = {
        allowed: false,
        rules: ['hire-not-active'],
        explanation: `Refused: this hire is ${record.state}, not active.`,
        envelopeAdvisory: false,
      };
      await this.deps.store.put(
        this.#trace(record, 'mandate-check', 'blocked', [], decision.explanation),
      );
      return decision;
    }

    const m = checkMandate(
      { to: candidate.to, value: candidate.value, token: candidate.token },
      record.mandate,
      record.mandateState,
      this.now(),
    );
    const e = checkAgainstEnvelope(
      {
        ...candidate,
        cumulativeValueWei: record.mandateState.spent,
        priorActionCount: record.mandateState.actions,
      },
      record.envelope,
      record.envelopePolicy,
    );

    // An advisory envelope is recorded but does not refuse — too few auditions
    // to bound behaviour would otherwise block a good agent the first time it
    // did anything slightly different.
    const envelopeBlocks = !e.allowed && !e.advisory;
    const allowed = m.allowed && !envelopeBlocks;
    const rules = [...m.rules, ...(e.allowed ? [] : e.rules)];
    const explanation = allowed
      ? ''
      : [m.explanation, envelopeBlocks ? e.explanation : ''].filter(Boolean).join(' ');

    let next = this.#trace(
      record,
      m.allowed ? 'gate-check' : 'mandate-check',
      allowed ? 'ok' : 'blocked',
      rules,
      allowed
        ? `admitted ${formatBaseUnits(candidate.value, record.mandate.bounds.totalSpendCap.decimals)} ${record.mandate.bounds.totalSpendCap.symbol} to ${candidate.to ?? 'contract creation'}`
        : explanation,
    );
    if (allowed) next = { ...next, mandateState: applySpend(next.mandateState, candidate.value) };
    await this.deps.store.put(next);

    return { allowed, rules, explanation, envelopeAdvisory: e.advisory };
  }

  /** Idempotent, and legal from every live state. */
  async revoke(hireId: string, reason = 'revoked by owner'): Promise<HireRecord> {
    const record = await this.#require(hireId);
    if (record.state === 'revoked') return record;

    assertTransition(record.state, 'revoked');
    const next: HireRecord = {
      ...this.#trace(record, 'revoke', 'ok', [], reason),
      state: 'revoked',
      mandateState: revokeState(record.mandateState, this.now()),
    };
    await this.deps.store.put(next);
    return next;
  }

  async settle(hireId: string): Promise<HireRecord> {
    const record = await this.#require(hireId);
    if (record.escrowJobId === null) {
      throw new BenchError('NOT_FOUND', `hire ${hireId} has no escrow job to settle`);
    }
    let next = this.#advance(record, 'settling', 'settle', `settling escrow ${record.escrowJobId}`);
    await this.deps.store.put(next);

    try {
      const tx = await this.deps.escrow.settle(record.escrowJobId);
      next = this.#advance(next, 'settled', 'settle', `settled (${tx})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      next = {
        ...this.#trace(next, 'settle', 'failed', [], reason),
        state: 'failed',
        failureReason: reason,
      };
    }
    await this.deps.store.put(next);
    return next;
  }

  async #require(hireId: string): Promise<HireRecord> {
    const record = await this.deps.store.get(hireId);
    if (record === null) throw new BenchError('NOT_FOUND', `hire ${hireId} not found`);
    return record;
  }

  #trace(
    record: HireRecord,
    step: TraceEntry['step'],
    outcome: TraceEntry['outcome'],
    rules: readonly string[],
    detail: string,
  ): HireRecord {
    return {
      ...record,
      trace: appendTrace(record.trace, {
        at: this.now(),
        step,
        outcome,
        rules: rules as TraceEntry['rules'],
        detail,
      }),
    };
  }

  #advance(
    record: HireRecord,
    to: HireState,
    step: TraceEntry['step'],
    detail: string,
  ): HireRecord {
    assertTransition(record.state, to);
    return { ...this.#trace(record, step, 'ok', [], detail), state: to };
  }
}

/** Reference store. Postgres implements the same interface in `@bench/db`. */
export class InMemoryHireStore implements HireStore {
  readonly #byId = new Map<string, HireRecord>();
  readonly #byKey = new Map<string, string>();

  /**
   * Atomic by virtue of the event loop: nothing awaits between the check and
   * the write, so no interleaving is possible **within one process**. That
   * caveat is the whole reason `PgHireStore` exists — this store cannot
   * arbitrate between two web instances, and is a reference implementation
   * and test double rather than something to run a marketplace on.
   */
  async claim(record: HireRecord): Promise<ClaimResult> {
    const heldBy = this.#byKey.get(record.idempotencyKey);
    if (heldBy !== undefined) {
      const winner = this.#byId.get(heldBy);
      if (winner !== undefined) return { claimed: false, record: winner };
    }
    this.#byId.set(record.id, record);
    this.#byKey.set(record.idempotencyKey, record.id);
    return { claimed: true, record };
  }

  async byIdempotencyKey(key: string): Promise<HireRecord | null> {
    const id = this.#byKey.get(key);
    return id === undefined ? null : (this.#byId.get(id) ?? null);
  }

  async get(id: string): Promise<HireRecord | null> {
    return this.#byId.get(id) ?? null;
  }

  async put(record: HireRecord): Promise<void> {
    this.#byId.set(record.id, record);
    this.#byKey.set(record.idempotencyKey, record.id);
  }

  async listByOwner(owner: Address): Promise<readonly HireRecord[]> {
    return [...this.#byId.values()].filter((r) => r.owner.toLowerCase() === owner.toLowerCase());
  }
}
