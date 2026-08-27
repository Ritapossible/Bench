import { describe, expect, it } from 'vitest';
import {
  appendTrace,
  applySpend,
  assertTransition,
  canTransition,
  checkMandate,
  confirmConsent,
  consentComplete,
  encodeMandate,
  formatBaseUnits,
  formatTokenAmount,
  mandateDigest,
  nextConsentStep,
  remaining,
  revoke,
  verifyTrace,
  EMPTY_MANDATE_STATE,
  HIRE_TRANSITIONS,
  type HireMandate,
  type HireState,
  type MandateCandidate,
  type TraceEntry,
} from '../src/index.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955' as const;
const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255' as const;
const STRANGER = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const;

const amount = (n: bigint) => ({ token: USDT, symbol: 'USDT', decimals: 18, amount: n });

const mandate: HireMandate = {
  id: 'mnd_1',
  version: 1,
  hireId: 'hire_1',
  owner: '0x1111111111111111111111111111111111111111',
  agent: { chain: 'bsc-testnet', tokenId: 1041n },
  sessionKey: '0x2222222222222222222222222222222222222222',
  bounds: {
    totalSpendCap: amount(1_000n),
    perTxCap: amount(200n),
    contractAllowlist: [VENUS],
    expiresAt: new Date('2026-09-01T00:00:00Z'),
    maxActions: 5,
  },
  nonce: '0xabcd',
  issuedAt: new Date('2026-08-25T00:00:00Z'),
};

const now = new Date('2026-08-26T00:00:00Z');
const candidate = (over: Partial<MandateCandidate> = {}): MandateCandidate => ({
  to: VENUS,
  value: 100n,
  token: USDT,
  ...over,
});

describe('mandate encoding', () => {
  it('is stable, and changes when any bound changes', () => {
    expect(mandateDigest(mandate)).toBe(mandateDigest({ ...mandate }));
    expect(mandateDigest({ ...mandate, bounds: { ...mandate.bounds, maxActions: 6 } })).not.toBe(
      mandateDigest(mandate),
    );
  });

  it('cannot be forged by putting a separator inside a field', () => {
    // Length-delimiting is the whole point: without it an allowlist entry
    // containing the separator could encode identically to a different
    // mandate, and a signature over one would authorise the other.
    const a = encodeMandate(mandate);
    const b = encodeMandate({ ...mandate, id: `mnd_1|${mandate.hireId}` });
    expect(a).not.toBe(b);
  });

  it('does not depend on allowlist order or address casing', () => {
    const shuffled: HireMandate = {
      ...mandate,
      bounds: { ...mandate.bounds, contractAllowlist: [VENUS.toUpperCase() as `0x${string}`] },
    };
    expect(mandateDigest(shuffled)).toBe(mandateDigest(mandate));
  });
});

describe('checkMandate', () => {
  it('allows a transaction inside every bound', () => {
    expect(checkMandate(candidate(), mandate, EMPTY_MANDATE_STATE, now).allowed).toBe(true);
  });

  it('refuses a contract that is not on the allowlist', () => {
    const d = checkMandate(candidate({ to: STRANGER }), mandate, EMPTY_MANDATE_STATE, now);
    expect(d.rules).toContain('contract-not-allowlisted');
    expect(d.explanation).toContain(STRANGER);
  });

  it('refuses contract creation, which has no destination to allowlist', () => {
    expect(
      checkMandate(candidate({ to: null }), mandate, EMPTY_MANDATE_STATE, now).rules,
    ).toContain('contract-not-allowlisted');
  });

  it('enforces per-transaction and cumulative ceilings separately', () => {
    expect(
      checkMandate(candidate({ value: 201n }), mandate, EMPTY_MANDATE_STATE, now).rules,
    ).toContain('per-tx-cap-exceeded');
    const nearlySpent = { ...EMPTY_MANDATE_STATE, spent: 950n };
    expect(checkMandate(candidate({ value: 100n }), mandate, nearlySpent, now).rules).toContain(
      'total-cap-exceeded',
    );
  });

  it('refuses a different token than the one the cap is denominated in', () => {
    expect(
      checkMandate(candidate({ token: STRANGER }), mandate, EMPTY_MANDATE_STATE, now).rules,
    ).toContain('wrong-token');
  });

  it('stops a loop that stays individually in-cap', () => {
    const used = { ...EMPTY_MANDATE_STATE, actions: 5 };
    expect(checkMandate(candidate({ value: 1n }), mandate, used, now).rules).toContain(
      'action-limit-reached',
    );
  });

  it('expires on its own, without anyone intervening', () => {
    const late = new Date('2026-09-02T00:00:00Z');
    expect(checkMandate(candidate(), mandate, EMPTY_MANDATE_STATE, late).rules).toContain(
      'expired',
    );
  });

  it('revocation beats an otherwise perfectly valid transaction', () => {
    const dead = revoke(EMPTY_MANDATE_STATE, now);
    const d = checkMandate(candidate(), mandate, dead, now);
    expect(d.allowed).toBe(false);
    expect(d.rules).toContain('revoked');
  });

  it('revoking twice keeps the first timestamp', () => {
    const first = revoke(EMPTY_MANDATE_STATE, now);
    expect(revoke(first, new Date('2027-01-01')).revokedAt).toEqual(now);
  });

  it('tracks headroom for the hire dashboard', () => {
    const after = applySpend(applySpend(EMPTY_MANDATE_STATE, 100n), 50n);
    expect(after.spent).toBe(150n);
    expect(remaining(mandate, after).spend).toBe(850n);
    expect(remaining(mandate, after).actions).toBe(3);
  });
});

describe('hire state machine', () => {
  it('permits only declared transitions', () => {
    expect(canTransition('draft', 'quoted')).toBe(true);
    // The failure this prevents is an agent spending against an escrow that
    // was never funded.
    expect(canTransition('quoted', 'active')).toBe(false);
    expect(() => assertTransition('quoted', 'active')).toThrow(/illegal hire transition/);
  });

  it('can be revoked from every live state', () => {
    for (const s of Object.keys(HIRE_TRANSITIONS) as HireState[]) {
      const terminal = HIRE_TRANSITIONS[s].length === 0;
      expect(terminal || canTransition(s, 'revoked')).toBe(true);
    }
  });

  it('can fail from every live state, so no hire gets stuck', () => {
    for (const s of Object.keys(HIRE_TRANSITIONS) as HireState[]) {
      const terminal = HIRE_TRANSITIONS[s].length === 0;
      expect(terminal || canTransition(s, 'failed')).toBe(true);
    }
  });

  it('leaves terminal states terminal', () => {
    for (const s of ['settled', 'revoked', 'failed'] as HireState[]) {
      expect(HIRE_TRANSITIONS[s]).toEqual([]);
    }
  });
});

describe('decision trace', () => {
  const build = (): readonly TraceEntry[] => {
    let t: readonly TraceEntry[] = [];
    t = appendTrace(t, {
      at: now,
      step: 'quote',
      outcome: 'ok',
      rules: [],
      detail: 'quoted 5 USDT',
    });
    t = appendTrace(t, {
      at: now,
      step: 'fund',
      outcome: 'ok',
      rules: [],
      detail: 'escrow funded',
    });
    t = appendTrace(t, {
      at: now,
      step: 'gate-check',
      outcome: 'blocked',
      rules: ['unseen-recipient'],
      detail: 'refused',
    });
    return t;
  };

  it('chains, and verifies clean', () => {
    const t = build();
    expect(t.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(verifyTrace(t)).toBeNull();
  });

  it('detects an edited entry, which is the entire point', () => {
    const t = [...build()];
    t[1] = { ...t[1]!, detail: 'escrow funded (actually it was not)' };
    expect(verifyTrace(t)).toBe(1);
  });

  it('detects a deleted entry', () => {
    const t = build();
    expect(verifyTrace([t[0]!, t[2]!])).toBe(1);
  });

  it('records both bounds into one trace', () => {
    const t = appendTrace(build(), {
      at: now,
      step: 'mandate-check',
      outcome: 'blocked',
      rules: ['total-cap-exceeded'],
      detail: 'over cap',
    });
    expect(verifyTrace(t)).toBeNull();
    expect(t.at(-1)?.rules).toContain('total-cap-exceeded');
  });
});

describe('consent checklist', () => {
  it('walks in order and completes', () => {
    let c: readonly string[] = [];
    expect(nextConsentStep(c as never)).toBe('reviewed-audition');
    c = confirmConsent(c as never, 'reviewed-audition');
    c = confirmConsent(c as never, 'set-spend-cap');
    c = confirmConsent(c as never, 'set-allowlist');
    c = confirmConsent(c as never, 'set-expiry');
    expect(consentComplete(c as never)).toBe(false);
    c = confirmConsent(c as never, 'reviewed-summary');
    expect(consentComplete(c as never)).toBe(true);
  });

  it('refuses to skip ahead', () => {
    // This is what stops a client bug — or a hurried user — producing a
    // mandate whose bounds nobody actually looked at.
    expect(() => confirmConsent([], 'reviewed-summary')).toThrow(/out of order/);
  });

  it('is idempotent for a step already confirmed', () => {
    const once = confirmConsent([], 'reviewed-audition');
    expect(confirmConsent(once, 'reviewed-audition')).toEqual(once);
  });
});

describe('human-readable amounts', () => {
  it('renders base units as a number a person can check', () => {
    // Raw base units in a refusal explanation is exactly the sort of thing
    // that makes an audit trail unreadable at the moment it matters.
    const usdt = (n: bigint) => ({ token: USDT, symbol: 'USDT', decimals: 18, amount: n });
    expect(formatTokenAmount(usdt(5n * 10n ** 18n))).toBe('5 USDT');
    expect(formatTokenAmount(usdt(1_500_000_000_000_000_000n))).toBe('1.5 USDT');
    expect(formatTokenAmount(usdt(0n))).toBe('0 USDT');
    expect(formatTokenAmount(usdt(1n))).toBe('0.000000000000000001 USDT');
    expect(formatTokenAmount(usdt(5n * 10n ** 18n), { symbol: false })).toBe('5');
  });

  it('truncates for display without ever rendering a real balance as zero', () => {
    // The balance table shows four decimals, and an 18-decimal token means most
    // holdings have far more. Truncating is fine; truncating a dust balance to
    // "0" is not - it turns "you hold a little" into "you hold nothing".
    expect(formatBaseUnits(34_978_943_289_116_195_355n, 18, 4)).toBe('34.9789');
    expect(formatBaseUnits(1_000_000_000_000_000_000n, 18, 4)).toBe('1');
    expect(formatBaseUnits(0n, 18, 4)).toBe('0');

    // Below the display precision: the full value survives rather than
    // collapsing to zero.
    expect(formatBaseUnits(1n, 18, 4)).toBe('0.000000000000000001');
    expect(formatBaseUnits(50_000_000_000_000n, 18, 4)).toBe('0.00005');

    // Truncation happens on the digits, never through a float - a value this
    // size loses precision the moment it becomes a Number.
    expect(formatBaseUnits(123_456_789_012_345_678_901_234_567n, 18, 2)).toBe('123456789.01');

    // Without a limit the exact value is preserved, which is what the decision
    // trace needs.
    expect(formatBaseUnits(34_978_943_289_116_195_355n, 18)).toBe('34.978943289116195355');
  });

  it('puts formatted amounts into refusal explanations, not base units', () => {
    // Realistic denominations: a per-tx cap of 2 USDT and an attempt at 3.
    const unit = 10n ** 18n;
    const realistic: HireMandate = {
      ...mandate,
      bounds: {
        ...mandate.bounds,
        totalSpendCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 10n * unit },
        perTxCap: { token: USDT, symbol: 'USDT', decimals: 18, amount: 2n * unit },
      },
    };
    const d = checkMandate(candidate({ value: 3n * unit }), realistic, EMPTY_MANDATE_STATE, now);
    expect(d.rules).toContain('per-tx-cap-exceeded');
    expect(d.explanation).toContain('3 USDT');
    expect(d.explanation).toContain('2 USDT');
    // The unreadable form must not survive into something a person reads.
    expect(d.explanation).not.toContain('3000000000000000000');
  });
});
