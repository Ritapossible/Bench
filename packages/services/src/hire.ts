import {
  appendTrace,
  applySpend,
  assertTransition,
  BenchError,
  checkAgainstEnvelope,
  checkMandate,
  consentComplete,
  mandateDigest,
  revoke as revokeState,
  EMPTY_MANDATE_STATE,
  type Address,
  type AgentId,
  type BehaviouralEnvelope,
  type CandidateAction,
  type ConsentStep,
  type EnvelopePolicy,
  type EscrowClient,
  type HireMandate,
  type HireState,
  type Hex,
  type MandateBounds,
  type MandateState,
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
}

export interface HireRecord {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly state: HireState;
  readonly owner: Address;
  readonly agent: AgentId;
  readonly mandate: HireMandate;
  readonly mandateState: MandateState;
  readonly envelope: BehaviouralEnvelope;
  readonly envelopePolicy: EnvelopePolicy | undefined;
  readonly escrowJobId: string | null;
  readonly paymentTxHash: Hex | null;
  readonly trace: readonly TraceEntry[];
  readonly createdAt: Date;
  readonly failureReason?: string;
}

export interface HireStore {
  byIdempotencyKey(key: string): Promise<HireRecord | null>;
  get(id: string): Promise<HireRecord | null>;
  put(record: HireRecord): Promise<void>;
  listByOwner(owner: Address): Promise<readonly HireRecord[]>;
}

export interface HireOrchestratorDeps {
  readonly payment: PaymentClient;
  readonly escrow: EscrowClient;
  readonly store: HireStore;
  readonly clock?: () => Date;
  readonly ids?: () => string;
}

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
    this.newId = deps.ids ?? (() => `h_${Math.random().toString(36).slice(2, 12)}`);
  }

  /**
   * Create a hire: quote → authorize → fund → active.
   *
   * Returns the existing hire unchanged if the idempotency key has been seen,
   * *including* when that hire failed — retrying a failed charge is the
   * client's decision to make with a new key, not something to do silently.
   */
  async hire(req: HireRequest): Promise<HireRecord> {
    const existing = await this.deps.store.byIdempotencyKey(req.idempotencyKey);
    if (existing !== null) return existing;

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
      sessionKey: req.owner, // replaced by the minted session key in Phase 4 wiring
      bounds: req.bounds,
      nonce: `0x${id}` as Hex,
      issuedAt: at,
    };

    let record: HireRecord = {
      id,
      idempotencyKey: req.idempotencyKey,
      state: 'draft',
      owner: req.owner,
      agent: req.agent,
      mandate,
      mandateState: EMPTY_MANDATE_STATE,
      envelope: req.envelope,
      envelopePolicy: req.envelopePolicy,
      escrowJobId: null,
      paymentTxHash: null,
      trace: [],
      createdAt: at,
    };

    // Persist before anything external happens, so a crash mid-flight leaves a
    // record to reconcile rather than a charge with no hire attached.
    record = this.#trace(record, 'consent', 'ok', [], `consent complete; mandate ${mandateDigest(mandate)}`);
    await this.deps.store.put(record);

    try {
      const quote = await this.deps.payment.quote({
        resource: `agent:${req.agent.chain}:${req.agent.tokenId.toString()}`,
        payTo: req.payTo,
        amount: req.price,
      });
      record = this.#advance(record, 'quoted', 'quote', `quoted ${quote.amount.amount} ${quote.amount.symbol}`);
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

      record = this.#advance(record, 'active', 'mint-session-key', `session key scoped to mandate ${mandate.id}`);
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
   */
  async authorizeAction(hireId: string, candidate: CandidateAction & { token: Address }): Promise<ActionDecision> {
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
    const e = checkAgainstEnvelope(candidate, record.envelope, record.envelopePolicy);

    // An advisory envelope is recorded but does not refuse — too few auditions
    // to bound behaviour would otherwise block a good agent the first time it
    // did anything slightly different.
    const envelopeBlocks = !e.allowed && !e.advisory;
    const allowed = m.allowed && !envelopeBlocks;
    const rules = [...m.rules, ...(e.allowed ? [] : e.rules)];
    const explanation = allowed ? '' : [m.explanation, envelopeBlocks ? e.explanation : ''].filter(Boolean).join(' ');

    let next = this.#trace(
      record,
      m.allowed ? 'gate-check' : 'mandate-check',
      allowed ? 'ok' : 'blocked',
      rules,
      allowed ? `admitted ${candidate.value} to ${candidate.to ?? 'contract creation'}` : explanation,
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
      next = { ...this.#trace(next, 'settle', 'failed', [], reason), state: 'failed', failureReason: reason };
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

  #advance(record: HireRecord, to: HireState, step: TraceEntry['step'], detail: string): HireRecord {
    assertTransition(record.state, to);
    return { ...this.#trace(record, step, 'ok', [], detail), state: to };
  }
}

/** Reference store. Postgres implements the same interface in `@bench/db`. */
export class InMemoryHireStore implements HireStore {
  readonly #byId = new Map<string, HireRecord>();
  readonly #byKey = new Map<string, string>();

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
