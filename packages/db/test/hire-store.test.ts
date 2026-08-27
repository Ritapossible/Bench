import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  EMPTY_MANDATE_STATE,
  appendTrace,
  deriveEnvelope,
  verifyTrace,
  type Address,
  type HireRecord,
  type Hex,
  type InterceptedAction,
  type TokenAmount,
} from '@bench/core';
import { createDb, PgHireStore, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

/**
 * Integration tests against a real Postgres.
 *
 * Skipped when `TEST_DATABASE_URL` is unset so the default `vitest run` stays
 * dependency-free, but these are not optional extras: `claim`'s guarantee is a
 * property of a Postgres unique index under concurrency, and an in-memory fake
 * cannot exhibit it, fail to exhibit it, or tell you which. The only way to
 * know the dedupe works is to make two writers race for real.
 */

const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255' as Address;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;

const amount = (n: bigint): TokenAmount => ({ token: USDT, symbol: 'USDT', decimals: 18, amount: n });

const action = (to: Address, value: bigint): InterceptedAction => ({
  seq: 0,
  at: new Date('2026-08-01T00:00:00Z'),
  to,
  value,
  data: '0x',
  decoded: null,
  simulated: { success: true, gasUsed: 21_000n },
});

const envelope = deriveEnvelope([
  { actions: [action(VENUS, 100n)] },
  { actions: [action(VENUS, 120n)] },
  { actions: [action(VENUS, 90n)] },
]);

const record = (over: Partial<HireRecord> = {}): HireRecord => {
  const id = over.id ?? `h_${Math.random().toString(36).slice(2, 12)}`;
  return {
    id,
    idempotencyKey: over.idempotencyKey ?? `key_${id}`,
    state: 'draft',
    owner: OWNER,
    agent: { chain: 'bsc-testnet', tokenId: 1041n },
    mandate: {
      id: `mnd_${id}`,
      version: 1,
      hireId: id,
      owner: OWNER,
      agent: { chain: 'bsc-testnet', tokenId: 1041n },
      sessionKey: OWNER,
      bounds: {
        totalSpendCap: amount(1_000_000_000_000_000_000_000n),
        perTxCap: amount(200_000_000_000_000_000n),
        contractAllowlist: [VENUS],
        expiresAt: new Date('2026-12-01T00:00:00.000Z'),
        maxActions: 5,
      },
      nonce: `0x${id}` as Hex,
      issuedAt: new Date('2026-08-27T00:00:00.000Z'),
    },
    mandateState: EMPTY_MANDATE_STATE,
    envelope,
    envelopePolicy: undefined,
    escrowJobId: null,
    paymentTxHash: null,
    trace: appendTrace([], {
      at: new Date('2026-08-27T00:00:01.000Z'),
      step: 'consent',
      outcome: 'ok',
      rules: [],
      detail: 'consent complete',
    }),
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    ...over,
  };
};

describeDb('PgHireStore', () => {
  const db = createDb(URL ?? '');
  const store = new PgHireStore(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });

  beforeEach(async () => {
    await db.delete(schema.feedback);
    await db.delete(schema.hires);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('round-trips every field, including the bigints and dates JSON would mangle', async () => {
    const original = record();
    await store.claim(original);

    const read = await store.get(original.id);
    expect(read).not.toBeNull();
    // Structural equality across the whole record: a codec that drops a field
    // or returns a string where a bigint was is caught here rather than
    // downstream, where it would surface as an arithmetic bug.
    expect(read).toEqual(original);
    expect(typeof read?.mandate.bounds.totalSpendCap.amount).toBe('bigint');
    expect(read?.mandate.bounds.expiresAt).toBeInstanceOf(Date);
    expect(read?.agent.tokenId).toBe(1041n);
  });

  it('preserves the trace hash chain across a write and a read', async () => {
    const original = record();
    await store.claim(original);
    const read = await store.get(original.id);
    expect(verifyTrace(read?.trace ?? [])).toBeNull();
    expect(read?.trace[0]?.digest).toBe(original.trace[0]?.digest);
  });

  it('refuses to serve a hire whose trace was edited in the database', async () => {
    const original = record();
    await store.claim(original);

    // Exactly the attack the chain exists to detect: someone with write access
    // rewrites what an agent was recorded as doing, leaving the digests behind.
    await db.execute(
      `update hires set trace = jsonb_set(trace, '{0,detail}', '"nothing to see here"') where id = '${original.id}'`,
    );

    await expect(store.get(original.id)).rejects.toThrow(/broken decision trace/);
  });

  it('claims an unheld key and reports it as claimed', async () => {
    const r = record();
    const result = await store.claim(r);
    expect(result.claimed).toBe(true);
    expect(result.record.id).toBe(r.id);
  });

  it('refuses a second claim on the same key and returns the winner', async () => {
    const first = record({ idempotencyKey: 'shared' });
    const second = record({ idempotencyKey: 'shared' });

    expect((await store.claim(first)).claimed).toBe(true);
    const loser = await store.claim(second);

    expect(loser.claimed).toBe(false);
    expect(loser.record.id).toBe(first.id);
    expect(loser.record.id).not.toBe(second.id);
  });

  it('lets exactly one of many concurrent claims win the same key', async () => {
    // The test the whole design exists for. Read-then-write dedupe passes every
    // sequential test above and fails this one, because the interleaving only
    // happens when the writers genuinely overlap.
    const contenders = Array.from({ length: 12 }, () => record({ idempotencyKey: 'contended' }));
    const results = await Promise.all(contenders.map((r) => store.claim(r)));

    const winners = results.filter((r) => r.claimed);
    expect(winners).toHaveLength(1);

    // And every loser was handed the same winning hire, so a duplicated request
    // is answered with the real hire rather than an error or a second charge.
    const winnerId = winners[0]?.record.id;
    for (const r of results.filter((x) => !x.claimed)) {
      expect(r.record.id).toBe(winnerId);
    }

    const rows = await db.select().from(schema.hires);
    expect(rows).toHaveLength(1);
  });

  it('updates a claimed hire in place without creating a second row', async () => {
    const r = record();
    await store.claim(r);
    await store.put({ ...r, state: 'active', escrowJobId: 'job_1', paymentTxHash: '0xpaid' as Hex });

    const read = await store.get(r.id);
    expect(read?.state).toBe('active');
    expect(read?.escrowJobId).toBe('job_1');
    expect(await db.select().from(schema.hires)).toHaveLength(1);
  });

  it('refuses to put a hire that was never claimed', async () => {
    // `put` inserting would be a second path to creating a hire, bypassing the
    // uniqueness check that is the entire dedupe guarantee.
    await expect(store.put(record())).rejects.toThrow(/claim it before updating/);
  });

  it('finds hires by owner regardless of address casing', async () => {
    await store.claim(record());
    await store.claim(record());
    const found = await store.listByOwner(OWNER.toUpperCase().replace('0X', '0x') as Address);
    expect(found).toHaveLength(2);
  });

  it('carries a failure reason back out', async () => {
    const r = record();
    await store.claim(r);
    await store.put({ ...r, state: 'failed', failureReason: 'settlement reverted' });
    expect((await store.get(r.id))?.failureReason).toBe('settlement reverted');
  });
});
