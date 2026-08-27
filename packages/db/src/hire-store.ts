import {
  verifyTrace,
  BenchError,
  type Address,
  type AgentId,
  type BehaviouralEnvelope,
  type ClaimResult,
  type EnvelopePolicy,
  type HireMandate,
  type HireRecord,
  type HireState,
  type HireStore,
  type Hex,
  type MandateState,
  type TokenAmount,
  type TraceEntry,
} from '@bench/core';

import { eq, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import * as schema from './schema.js';

/**
 * Postgres HireStore - ARCHITECTURE.md 3.6.
 *
 * The in-memory store in @bench/services is a reference implementation and a
 * test double. This is the one a marketplace runs on, and it exists for two
 * reasons that memory cannot supply at any level of care:
 *
 *  1. **Dedupe has to arbitrate across instances.** `claim` resolves the race
 *     in the database with `INSERT ... ON CONFLICT DO NOTHING`, which is the
 *     only place two concurrent web instances actually meet. Everything above
 *     it - the orchestrator's early return, the client's retry - is a
 *     convenience layered on that one guarantee.
 *  2. **A trace that dies with the process proves nothing.** The decision trace
 *     is the artifact a user reads when an agent did something they did not
 *     expect, and it is worth exactly as much as its durability.
 *
 * ### Encoding
 *
 * jsonb columns are written through explicit codecs rather than `JSON.stringify`
 * on the domain object. Two of the fields that matter most - token amounts and
 * spend counters - are `bigint`, which `JSON.stringify` throws on, and `Date`
 * round-trips to a string that silently is not a `Date` any more. A generic
 * tagging scheme would handle both, but the trace is hash-chained: an
 * asymmetric round-trip does not corrupt data visibly, it invalidates every
 * digest downstream of the field that changed shape. Explicit codecs make that
 * symmetry checkable by reading them side by side, and `verifyTrace` on read
 * turns any remaining asymmetry into a loud failure rather than a quiet one.
 */

// ---------------------------------------------------------------------------
// Codecs. Each pair is written adjacently so encode/decode can be diffed by eye.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const encAgentId = (a: AgentId): Json => ({ chain: a.chain, tokenId: a.tokenId.toString() });
const decAgentId = (j: Json): AgentId => ({
  chain: j['chain'] as AgentId['chain'],
  tokenId: BigInt(j['tokenId'] as string),
});

const encAmount = (t: TokenAmount): Json => ({
  token: t.token,
  symbol: t.symbol,
  decimals: t.decimals,
  amount: t.amount.toString(),
});
const decAmount = (j: Json): TokenAmount => ({
  token: j['token'] as Address,
  symbol: j['symbol'] as string,
  decimals: j['decimals'] as number,
  amount: BigInt(j['amount'] as string),
});

const encMandate = (m: HireMandate): Json => ({
  id: m.id,
  version: m.version,
  hireId: m.hireId,
  owner: m.owner,
  agent: encAgentId(m.agent),
  sessionKey: m.sessionKey,
  bounds: {
    totalSpendCap: encAmount(m.bounds.totalSpendCap),
    perTxCap: encAmount(m.bounds.perTxCap),
    contractAllowlist: [...m.bounds.contractAllowlist],
    expiresAt: m.bounds.expiresAt.toISOString(),
    maxActions: m.bounds.maxActions,
  },
  nonce: m.nonce,
  issuedAt: m.issuedAt.toISOString(),
});
const decMandate = (j: Json): HireMandate => {
  const b = j['bounds'] as Json;
  return {
    id: j['id'] as string,
    version: 1,
    hireId: j['hireId'] as string,
    owner: j['owner'] as Address,
    agent: decAgentId(j['agent'] as Json),
    sessionKey: j['sessionKey'] as Address,
    bounds: {
      totalSpendCap: decAmount(b['totalSpendCap'] as Json),
      perTxCap: decAmount(b['perTxCap'] as Json),
      contractAllowlist: b['contractAllowlist'] as readonly Address[],
      expiresAt: new Date(b['expiresAt'] as string),
      maxActions: b['maxActions'] as number,
    },
    nonce: j['nonce'] as Hex,
    issuedAt: new Date(j['issuedAt'] as string),
  };
};

const encMandateState = (s: MandateState): Json => ({
  spent: s.spent.toString(),
  actions: s.actions,
  revokedAt: s.revokedAt === null ? null : s.revokedAt.toISOString(),
});
const decMandateState = (j: Json): MandateState => ({
  spent: BigInt(j['spent'] as string),
  actions: j['actions'] as number,
  revokedAt: j['revokedAt'] === null ? null : new Date(j['revokedAt'] as string),
});

const encEnvelope = (e: BehaviouralEnvelope): Json => ({
  recipients: [...e.recipients],
  selectors: [...e.selectors],
  maxSingleValueWei: e.maxSingleValueWei.toString(),
  maxCumulativeValueWei: e.maxCumulativeValueWei.toString(),
  maxActionCount: e.maxActionCount,
  maxPositionDropUsd: e.maxPositionDropUsd,
  sampleSize: e.sampleSize,
});
const decEnvelope = (j: Json): BehaviouralEnvelope => ({
  recipients: j['recipients'] as readonly Address[],
  selectors: j['selectors'] as readonly Hex[],
  maxSingleValueWei: BigInt(j['maxSingleValueWei'] as string),
  maxCumulativeValueWei: BigInt(j['maxCumulativeValueWei'] as string),
  maxActionCount: j['maxActionCount'] as number,
  maxPositionDropUsd: j['maxPositionDropUsd'] as number | null,
  sampleSize: j['sampleSize'] as number,
});

const encTrace = (t: readonly TraceEntry[]): Json[] =>
  t.map((e) => ({
    seq: e.seq,
    at: e.at.toISOString(),
    step: e.step,
    outcome: e.outcome,
    rules: [...e.rules],
    detail: e.detail,
    digest: e.digest,
  }));
const decTrace = (rows: Json[]): readonly TraceEntry[] =>
  rows.map((e) => ({
    seq: e['seq'] as number,
    at: new Date(e['at'] as string),
    step: e['step'] as TraceEntry['step'],
    outcome: e['outcome'] as TraceEntry['outcome'],
    rules: e['rules'] as TraceEntry['rules'],
    detail: e['detail'] as string,
    digest: e['digest'] as Hex,
  }));

type Row = typeof schema.hires.$inferSelect;

function toRecord(row: Row): HireRecord {
  const agents = row.agentIds as Json[];
  const first = agents[0];
  if (first === undefined) {
    throw new BenchError('NOT_FOUND', `hire ${row.id} has no agent`);
  }
  const trace = decTrace(row.trace as Json[]);

  // Verified on read, never trusted. A trace is only evidence if tampering with
  // the row it lives in is detectable, and this is where that detection has to
  // happen - anyone with write access to the database can edit a `detail`
  // string, and nothing else in the system would notice.
  const tampered = verifyTrace(trace);
  if (tampered !== null) {
    throw new BenchError(
      'TRACE_TAMPERED',
      `hire ${row.id} has a broken decision trace at entry ${tampered}; refusing to serve it`,
    );
  }

  const policy = row.envelopePolicy as Json | null;
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    state: row.status as HireState,
    owner: row.userAddress as Address,
    agent: decAgentId(first),
    mandate: decMandate(row.mandate as Json),
    mandateState: decMandateState(row.mandateState as Json),
    envelope: decEnvelope(row.envelope as Json),
    envelopePolicy: policy === null ? undefined : (policy as unknown as EnvelopePolicy),
    escrowJobId: row.escrowJobId,
    paymentTxHash: row.paymentTxHash as Hex | null,
    trace,
    createdAt: row.createdAt,
    ...(row.failureReason === null ? {} : { failureReason: row.failureReason }),
  };
}

function toRow(r: HireRecord): typeof schema.hires.$inferInsert {
  return {
    id: r.id,
    idempotencyKey: r.idempotencyKey,
    userAddress: r.owner.toLowerCase(),
    agentIds: [encAgentId(r.agent)],
    escrowJobId: r.escrowJobId,
    status: r.state,
    mandate: encMandate(r.mandate),
    mandateState: encMandateState(r.mandateState),
    envelope: encEnvelope(r.envelope),
    envelopePolicy: r.envelopePolicy ?? null,
    trace: encTrace(r.trace),
    paymentTxHash: r.paymentTxHash,
    failureReason: r.failureReason ?? null,
    createdAt: r.createdAt,
    updatedAt: new Date(),
  };
}

export class PgHireStore implements HireStore {
  constructor(private readonly db: Db) {}

  /**
   * `INSERT ... ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`.
   *
   * An empty `returning` means another request already owns the key, so this
   * caller is a duplicate and must not spend. The winner's row is then read
   * back and handed to the loser, which is what makes a retried hire request
   * return the original hire rather than an error.
   *
   * The follow-up read is deliberately not wrapped in a transaction with the
   * insert: under READ COMMITTED the conflicting row is guaranteed to be
   * visible once the insert has resolved the conflict against it.
   */
  async claim(record: HireRecord): Promise<ClaimResult> {
    const inserted = await this.db
      .insert(schema.hires)
      .values(toRow(record))
      .onConflictDoNothing({ target: schema.hires.idempotencyKey })
      .returning({ id: schema.hires.id });

    if (inserted.length > 0) return { claimed: true, record };

    const winner = await this.byIdempotencyKey(record.idempotencyKey);
    if (winner === null) {
      // The conflicting row disappeared between the insert and the read. Nothing
      // in this system deletes hires, so this is a corrupted database rather
      // than a race to retry through.
      throw new BenchError(
        'NOT_FOUND',
        `idempotency key ${record.idempotencyKey} conflicted on insert but no hire holds it`,
      );
    }
    return { claimed: false, record: winner };
  }

  async byIdempotencyKey(key: string): Promise<HireRecord | null> {
    const rows = await this.db
      .select()
      .from(schema.hires)
      .where(eq(schema.hires.idempotencyKey, key))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async get(id: string): Promise<HireRecord | null> {
    const rows = await this.db.select().from(schema.hires).where(eq(schema.hires.id, id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /**
   * Update in place, never insert.
   *
   * A hire comes into existence through `claim` and only through `claim`. If
   * `put` could insert, it would be a second path to creating a hire that does
   * not go through the uniqueness check - which is the entire dedupe guarantee,
   * bypassed by the method most likely to be called in a retry loop.
   */
  async put(record: HireRecord): Promise<void> {
    const row = toRow(record);
    const updated = await this.db
      .update(schema.hires)
      .set({
        status: row.status,
        escrowJobId: row.escrowJobId,
        mandate: row.mandate,
        mandateState: row.mandateState,
        envelope: row.envelope,
        envelopePolicy: row.envelopePolicy,
        trace: row.trace,
        paymentTxHash: row.paymentTxHash,
        failureReason: row.failureReason,
        updatedAt: new Date(),
      })
      .where(eq(schema.hires.id, record.id))
      .returning({ id: schema.hires.id });

    if (updated.length === 0) {
      throw new BenchError('NOT_FOUND', `hire ${record.id} does not exist; claim it before updating it`);
    }
  }

  async listByOwner(owner: Address): Promise<readonly HireRecord[]> {
    const rows = await this.db
      .select()
      .from(schema.hires)
      .where(eq(sql`lower(${schema.hires.userAddress})`, owner.toLowerCase()))
      .orderBy(schema.hires.createdAt);
    return rows.map(toRecord);
  }
}
