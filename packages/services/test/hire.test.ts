import { describe, expect, it } from 'vitest';
import {
  deriveEnvelope,
  verifyTrace,
  type Address,
  type EscrowClient,
  type EscrowJob,
  type Hex,
  type InterceptedAction,
  type PaymentClient,
  type TokenAmount,
} from '@bench/core';
import { HireOrchestrator, InMemoryHireStore, type HireRequest } from '../src/hire.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255' as Address;
const STRANGER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as Address;
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

/** Three runs so the envelope is enforceable rather than advisory. */
const envelope = deriveEnvelope([
  { actions: [action(VENUS, 100n)] },
  { actions: [action(VENUS, 120n)] },
  { actions: [action(VENUS, 90n)] },
]);

class FakePayment implements PaymentClient {
  settled = 0;
  constructor(private readonly failOn?: 'quote' | 'authorize' | 'settle') {}
  async quote(req: { readonly payTo: Address; readonly amount: TokenAmount }) {
    if (this.failOn === 'quote') throw new Error('quote unavailable');
    return { payTo: req.payTo, amount: req.amount, scheme: 'permit2-upto' as const, expiresAt: new Date('2026-12-01'), nonce: '0x01' as Hex };
  }
  async authorize(quote: Awaited<ReturnType<FakePayment['quote']>>) {
    if (this.failOn === 'authorize') throw new Error('user rejected');
    return { quote, signature: '0xsig' as Hex, ceiling: quote.amount };
  }
  async settle(auth: Awaited<ReturnType<FakePayment['authorize']>>) {
    if (this.failOn === 'settle') throw new Error('settlement reverted');
    this.settled += 1;
    return { txHash: '0xpaid' as Hex, settled: auth.quote.amount, at: new Date() };
  }
  async spentAgainst() { return amount(0n); }
}

class FakeEscrow implements EscrowClient {
  opened = 0;
  #job: EscrowJob | null = null;
  async openJob(spec: { agent: EscrowJob['agent']; client: Address; amount: TokenAmount }) {
    this.opened += 1;
    this.#job = { id: `job_${this.opened}`, agent: spec.agent, client: spec.client, amount: spec.amount, status: 'open', disputeWindowEndsAt: null, deliveryProof: null };
    return this.#job;
  }
  async fund() { return '0xfund' as Hex; }
  async deliver() { return '0xdeliver' as Hex; }
  async settle() { return '0xsettle' as Hex; }
  async dispute() { return '0xdispute' as Hex; }
  async get() { return this.#job; }
}

const request = (over: Partial<HireRequest> = {}): HireRequest => ({
  idempotencyKey: 'key-1',
  owner: OWNER,
  agent: { chain: 'bsc-testnet', tokenId: 1041n },
  bounds: {
    totalSpendCap: amount(1_000n),
    perTxCap: amount(200n),
    contractAllowlist: [VENUS],
    expiresAt: new Date('2026-12-01T00:00:00Z'),
    maxActions: 5,
  },
  consent: ['reviewed-audition', 'set-spend-cap', 'set-allowlist', 'set-expiry', 'reviewed-summary'],
  taskSpec: 'keep the Venus health factor above 1.5',
  price: amount(5n),
  payTo: '0x3333333333333333333333333333333333333333' as Address,
  disputeWindowSec: 3_600,
  envelope,
  ...over,
});

const build = (payment = new FakePayment(), escrow = new FakeEscrow()) => {
  const store = new InMemoryHireStore();
  return { store, payment, escrow, o: new HireOrchestrator({ payment, escrow, store, clock: () => new Date('2026-08-26T00:00:00Z') }) };
};

describe('HireOrchestrator', () => {
  it('drives a hire to active and traces every step', async () => {
    const { o } = build();
    const h = await o.hire(request());
    expect(h.state).toBe('active');
    expect(h.escrowJobId).toBe('job_1');
    expect(h.paymentTxHash).toBe('0xpaid');
    expect(verifyTrace(h.trace)).toBeNull();
    expect(h.trace.map((t) => t.step)).toEqual(['consent', 'quote', 'authorize', 'fund', 'mint-session-key']);
  });

  it('is idempotent — a retry never charges twice', async () => {
    const { o, payment, escrow } = build();
    const a = await o.hire(request());
    const b = await o.hire(request());
    expect(b.id).toBe(a.id);
    expect(payment.settled).toBe(1);
    expect(escrow.opened).toBe(1);
  });

  it('refuses to move money on incomplete consent', async () => {
    const { o, payment } = build();
    await expect(o.hire(request({ consent: ['reviewed-audition'] }))).rejects.toThrow(/consent is incomplete/);
    expect(payment.settled).toBe(0);
  });

  it('lands a mid-flight failure in `failed` with the reason traced, not as an escape', async () => {
    const { o } = build(new FakePayment('settle'));
    const h = await o.hire(request());
    expect(h.state).toBe('failed');
    expect(h.failureReason).toMatch(/settlement reverted/);
    expect(verifyTrace(h.trace)).toBeNull();
    expect(h.trace.at(-1)?.outcome).toBe('failed');
  });

  it('does not silently retry a failed hire under the same key', async () => {
    // Retrying a charge is the client's decision, made with a new key.
    const { o } = build(new FakePayment('settle'));
    const first = await o.hire(request());
    const second = await o.hire(request());
    expect(second.id).toBe(first.id);
    expect(second.state).toBe('failed');
  });
});

describe('authorizeAction — both bounds', () => {
  // Only the transaction. Spending history is the orchestrator's to supply,
  // from persisted state - see ProposedAction.
  const candidate = (to: Address, value: bigint) => ({
    to, value, data: '0x' as Hex, token: USDT,
  });

  it('counts spending against the envelope from recorded state, not from the caller', async () => {
    // The regression this exists for: every call site used to pass
    // cumulativeValueWei: 0n, so the envelope's cumulative bound could never
    // fire however much the agent moved. A bound evaluated against numbers the
    // caller supplies is not a bound - it is a report that one was checked.
    //
    // The envelope here was derived from auditions totalling 310 wei, so with
    // the default 100% action tolerance and 50% value tolerance the cumulative
    // ceiling is well under what four 100-wei actions reach.
    const { o, store } = build();
    const h = await o.hire(request({ bounds: { ...request().bounds, maxActions: 50, totalSpendCap: amount(100_000n) } }));

    const outcomes: boolean[] = [];
    for (let i = 0; i < 6; i += 1) {
      outcomes.push((await o.authorizeAction(h.id, candidate(VENUS, 100n))).allowed);
    }

    // It admits some and then stops. Under the old signature every one of these
    // was admitted, because each claimed to be the agent's first action.
    expect(outcomes).toContain(false);

    const after = await store.get(h.id);
    const blocked = after!.trace.filter((t) => t.outcome === 'blocked');
    expect(blocked.length).toBeGreaterThan(0);
    expect(
      blocked.some((t) =>
        t.rules.some(
          (r) => r === 'cumulative-value-exceeds-observed' || r === 'action-count-exceeds-observed',
        ),
      ),
    ).toBe(true);
  });

  it('admits what the owner authorised and the agent has demonstrated', async () => {
    const { o } = build();
    const h = await o.hire(request());
    const d = await o.authorizeAction(h.id, candidate(VENUS, 100n));
    expect(d.allowed).toBe(true);
  });

  it('refuses on the mandate alone — an unauthorised contract', async () => {
    const { o } = build();
    const h = await o.hire(request());
    const d = await o.authorizeAction(h.id, candidate(STRANGER, 100n));
    expect(d.allowed).toBe(false);
    expect(d.rules).toContain('contract-not-allowlisted');
    expect(d.rules).toContain('unseen-recipient'); // both bounds report
  });

  it('refuses on the envelope alone — authorised, but never demonstrated', async () => {
    // Inside the mandate's per-tx cap of 200, but far past anything this agent
    // did in audition. Neither bound subsumes the other.
    const { o } = build();
    const h = await o.hire(request());
    const d = await o.authorizeAction(h.id, candidate(VENUS, 190n));
    expect(d.allowed).toBe(false);
    expect(d.rules).toContain('value-exceeds-observed');
    expect(d.rules).not.toContain('per-tx-cap-exceeded');
  });

  it('accumulates spend, so a sequence inside the per-tx cap still hits the total', async () => {
    // About the *mandate's* total cap specifically, so the envelope is widened
    // out of the way - both bounds accumulate now, and a test that cannot say
    // which one refused is not testing either.
    const { o } = build();
    const h = await o.hire(
      request({
        bounds: { ...request().bounds, totalSpendCap: amount(250n) },
        envelope: { ...envelope, maxCumulativeValueWei: 10_000n, maxActionCount: 100 },
      }),
    );
    expect((await o.authorizeAction(h.id, candidate(VENUS, 100n))).allowed).toBe(true);
    expect((await o.authorizeAction(h.id, candidate(VENUS, 100n))).allowed).toBe(true);
    const third = await o.authorizeAction(h.id, candidate(VENUS, 100n));
    expect(third.allowed).toBe(false);
    expect(third.rules).toContain('total-cap-exceeded');
  });

  it('records a refusal in the trace, tamper-evidently', async () => {
    const { o, store } = build();
    const h = await o.hire(request());
    await o.authorizeAction(h.id, candidate(STRANGER, 100n));
    const after = await store.get(h.id);
    expect(verifyTrace(after!.trace)).toBeNull();
    expect(after!.trace.at(-1)?.outcome).toBe('blocked');
  });

  it('refuses everything once revoked, and revoke is idempotent', async () => {
    const { o } = build();
    const h = await o.hire(request());
    const revoked = await o.revoke(h.id);
    expect(revoked.state).toBe('revoked');
    expect((await o.revoke(h.id)).state).toBe('revoked');

    const d = await o.authorizeAction(h.id, candidate(VENUS, 100n));
    expect(d.allowed).toBe(false);
    expect(d.rules).toContain('hire-not-active');
  });

  it('treats a thin envelope as advisory rather than blocking a good agent', async () => {
    const thin = deriveEnvelope([{ actions: [action(VENUS, 100n)] }]);
    const { o } = build();
    const h = await o.hire(request({ envelope: thin }));
    const d = await o.authorizeAction(h.id, candidate(VENUS, 150n));
    expect(d.allowed).toBe(true);
    expect(d.envelopeAdvisory).toBe(true);
  });
});
