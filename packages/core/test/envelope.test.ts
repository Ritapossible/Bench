import { describe, expect, it } from 'vitest';
import {
  checkAgainstEnvelope,
  deriveEnvelope,
  DEFAULT_ENVELOPE_POLICY,
  isEnvelopeThin,
  type CandidateAction,
  type InterceptedAction,
} from '../src/index.js';

const action = (to: string | null, value: bigint, data = '0x'): InterceptedAction => ({
  seq: 0,
  at: new Date('2026-08-01T00:00:00Z'),
  to: to as `0x${string}` | null,
  value,
  data: data as `0x${string}`,
  decoded: null,
  simulated: { success: true, gasUsed: 21_000n },
});

const KNOWN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const STRANGER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TRANSFER = '0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001';

/** Three runs, so the envelope is enforceable rather than advisory. */
const runs = [
  { actions: [action(KNOWN, 100n), action(KNOWN, 200n, TRANSFER)], positionDropUsd: 12 },
  { actions: [action(KNOWN, 150n)], positionDropUsd: 8 },
  { actions: [action(KNOWN, 100n, TRANSFER)], positionDropUsd: 10 },
];

const envelope = deriveEnvelope(runs);

const candidate = (over: Partial<CandidateAction> = {}): CandidateAction => ({
  to: KNOWN as `0x${string}`,
  value: 100n,
  data: '0x',
  cumulativeValueWei: 0n,
  priorActionCount: 0,
  ...over,
});

describe('deriveEnvelope', () => {
  it('folds per-run maxima rather than flattening every action together', () => {
    // Flattening would let a two-action run and a one-action run average into
    // a bound that describes neither.
    expect(envelope.maxSingleValueWei).toBe(200n);
    expect(envelope.maxCumulativeValueWei).toBe(300n); // run 1: 100 + 200
    expect(envelope.maxActionCount).toBe(2);
    expect(envelope.maxPositionDropUsd).toBe(12);
    expect(envelope.sampleSize).toBe(3);
  });

  it('records recipients and selectors seen, lowercased', () => {
    expect(envelope.recipients).toEqual([KNOWN]);
    expect(envelope.selectors).toContain('0x');
    expect(envelope.selectors).toContain('0xa9059cbb');
  });

  it('is thin below three auditions, and says so', () => {
    expect(isEnvelopeThin(deriveEnvelope(runs.slice(0, 2)))).toBe(true);
    expect(isEnvelopeThin(envelope)).toBe(false);
  });
});

describe('checkAgainstEnvelope', () => {
  it('allows behaviour the agent already demonstrated', () => {
    const d = checkAgainstEnvelope(candidate(), envelope);
    expect(d.allowed).toBe(true);
    expect(d.rules).toEqual([]);
    expect(d.advisory).toBe(false);
  });

  it('refuses a recipient the agent never touched — the headline rule', () => {
    // A compromised or prompt-injected agent shows up first as a transfer
    // somewhere it has never sent funds.
    const d = checkAgainstEnvelope(candidate({ to: STRANGER as `0x${string}` }), envelope);
    expect(d.allowed).toBe(false);
    expect(d.rules).toContain('unseen-recipient');
    expect(d.explanation).toContain(STRANGER);
    expect(d.explanation).toContain('3 auditions');
  });

  it('refuses a function it never called', () => {
    const d = checkAgainstEnvelope(
      candidate({ data: '0xdeadbeef0000' as `0x${string}` }),
      envelope,
    );
    expect(d.rules).toContain('unseen-call');
  });

  it('allows headroom over the observed maximum, then refuses past it', () => {
    // Default tolerance is 1.5x: an agent that moved at most 200 will
    // eventually need 201, and a bound pinned to the exact maximum is a
    // straitjacket rather than a safety bound.
    expect(checkAgainstEnvelope(candidate({ value: 300n }), envelope).allowed).toBe(true);
    expect(checkAgainstEnvelope(candidate({ value: 301n }), envelope).rules).toContain(
      'value-exceeds-observed',
    );
  });

  it('bounds cumulative spend across the whole hire, not just one transaction', () => {
    const d = checkAgainstEnvelope(candidate({ value: 100n, cumulativeValueWei: 400n }), envelope);
    expect(d.rules).toContain('cumulative-value-exceeds-observed');
  });

  it('bounds how many actions a hire may take', () => {
    // maxActionCount 2, tolerance 100% -> ceiling of 4.
    expect(checkAgainstEnvelope(candidate({ priorActionCount: 3 }), envelope).allowed).toBe(true);
    expect(checkAgainstEnvelope(candidate({ priorActionCount: 4 }), envelope).rules).toContain(
      'action-count-exceeds-observed',
    );
  });

  it('refuses a simulated drawdown worse than anything seen in audition', () => {
    const d = checkAgainstEnvelope(candidate({ simulatedPositionDropUsd: 30 }), envelope);
    expect(d.rules).toContain('position-drop-exceeds-observed');
  });

  it('reports every rule that fired, not just the first', () => {
    const d = checkAgainstEnvelope(
      candidate({
        to: STRANGER as `0x${string}`,
        value: 10_000n,
        data: '0xdeadbeef00' as `0x${string}`,
      }),
      envelope,
    );
    expect(d.rules.length).toBeGreaterThanOrEqual(3);
    expect(d.explanation).toContain('; and ');
  });

  it('marks a decision advisory when the envelope is too thin to enforce', () => {
    const thin = deriveEnvelope(runs.slice(0, 1));
    const d = checkAgainstEnvelope(candidate({ to: STRANGER as `0x${string}` }), thin);
    expect(d.allowed).toBe(false);
    expect(d.advisory).toBe(true); // record it; do not act on it
  });

  it('can be relaxed per-policy without touching the envelope', () => {
    const d = checkAgainstEnvelope(candidate({ to: STRANGER as `0x${string}` }), envelope, {
      ...DEFAULT_ENVELOPE_POLICY,
      requireKnownRecipient: false,
    });
    expect(d.allowed).toBe(true);
  });
});
