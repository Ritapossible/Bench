import { describe, expect, it } from 'vitest';
import { UnconfiguredArbiter } from '../src/dispute/unconfigured-arbiter.js';
import {
  canonicalJson,
  decodeDispute,
  decodeVerdict,
  termsDigest,
} from '../src/dispute/genlayer-arbiter.js';
import type { DisputeTerms } from '@bench/core';

const TERMS: DisputeTerms = {
  mandate: {
    total_cap: '1000000000000000000',
    per_tx_cap: '500000000000000000',
    allowlist: ['0xaaaa'],
    expires_at: 1_767_229_200,
    max_actions: 5,
    token: '0xtoken',
  },
  envelope: {
    recipients: ['0xaaaa'],
    selectors: ['0x38ed1739'],
    max_single_value: '200000000000000000',
    max_cumulative_value: '600000000000000000',
    max_action_count: 3,
    sample_size: 3,
  },
  policy: {
    value_tolerance_bps: 5_000,
    action_tolerance_bps: 10_000,
    require_known_recipient: true,
    require_known_selector: true,
  },
};

describe('UnconfiguredArbiter', () => {
  const arbiter = new UnconfiguredArbiter();

  it('reports itself unavailable rather than pretending', () => {
    expect(arbiter.available).toBe(false);
    expect(arbiter.locator).toBeNull();
  });

  it('refuses every write, and that is the feature', async () => {
    /**
     * The obvious thing to build here is an in-memory arbiter that returns a
     * plausible verdict so the demo never blocks. It would also be Bench ruling
     * on disputes about agents Bench lists, ranks and takes a cut of - and it
     * would look identical to the real thing from outside.
     *
     * Every other adapter in this codebase has a fake behind it and should.
     * This one must not: the property being faked is not "a ruling happens", it
     * is "the ruling does not come from us", and a stub cannot fake that. It can
     * only contradict it while appearing to satisfy it.
     */
    await expect(
      arbiter.registerHire({
        hireId: 'h-1',
        agent: { chain: 'bsc-mainnet', tokenId: 1n },
        client: `0x${'11'.repeat(20)}`,
        respondent: `0x${'22'.repeat(20)}`,
        terms: TERMS,
        recordUrl: 'https://bench-bnb.vercel.app/api/hires/h-1/actions',
      }),
    ).rejects.toThrow(/not adjudicated on this deployment/);

    await expect(
      arbiter.openDispute({
        hireId: 'h-1',
        ground: 'breach',
        engagement: 'rebalance to 50/50',
        criteria: ['it rebalanced'],
        evidenceUrls: [],
        bond: 1n,
      }),
    ).rejects.toThrow(/GENLAYER_RPC_URL/);

    await expect(arbiter.adjudicate(0, TERMS)).rejects.toThrow();
    await expect(arbiter.answer(0, [])).rejects.toThrow();
  });

  it('answers reads with absence, so a hire page still renders', async () => {
    // "Does this hire have a dispute?" has a perfectly good answer on a
    // deployment with no arbiter, and it is "no". Faulting would turn every
    // hire page into an error boundary over a question that is not in doubt.
    expect(await arbiter.get(0)).toBeNull();
    expect(await arbiter.forHire('h-1')).toEqual([]);
    expect(await arbiter.independence(0)).toEqual({
      independent: 0,
      claimant: 0,
      respondent: 0,
      marketplace: 0,
      unclassified: 0,
    });
  });
});

describe('canonicalJson', () => {
  it('sorts keys so two encoders cannot disagree', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order, which is meaning rather than formatting', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('digests the same terms to the same value regardless of key order', () => {
    const shuffled = {
      policy: TERMS.policy,
      envelope: TERMS.envelope,
      mandate: TERMS.mandate,
    } as DisputeTerms;
    expect(termsDigest(shuffled)).toBe(termsDigest(TERMS));
  });
});

describe('decodeVerdict', () => {
  it('reads a verdict the contract wrote', () => {
    const v = decodeVerdict(
      JSON.stringify({
        ruling: 'upheld',
        resolved_by: 'replay',
        criteria: [{ id: 1, status: 'unmet', confidence: 100 }],
        sources_reachable: 2,
        evidence: { independent: 1, claimant: 1, respondent: 0, marketplace: 1, unclassified: 0 },
        observed: { findings: [{ rule: 'total-cap-exceeded', seq: 3 }] },
      }),
    );
    expect(v?.ruling).toBe('upheld');
    expect(v?.resolvedBy).toBe('replay');
    expect(v?.criteria[0]).toEqual({ id: 1, status: 'unmet', confidence: 100 });
    expect(v?.evidence.marketplace).toBe(1);
    expect(v?.observed).toEqual({ findings: [{ rule: 'total-cap-exceeded', seq: 3 }] });
  });

  it('never faults on a verdict it cannot read', () => {
    // The dispute's *state* is stored separately and is the thing a reader
    // needs. A page that threw here would lose the ruling and the state.
    expect(decodeVerdict('')).toBeNull();
    expect(decodeVerdict('not json')).toBeNull();
    expect(decodeVerdict('[]')).toBeNull();
    expect(decodeVerdict('null')).toBeNull();
  });

  it('falls to unresolved on a ruling it does not recognise', () => {
    expect(decodeVerdict('{"ruling":"guilty","criteria":[]}')?.ruling).toBe('unresolved');
  });
});

describe('decodeDispute', () => {
  const raw = {
    hire_id: 'h-1',
    ground: 'BREACH',
    state: 'UPHELD',
    claimant: `0x${'11'.repeat(20)}`,
    respondent: `0x${'22'.repeat(20)}`,
    criteria: ['it spent past the cap'],
    sources: ['https://bench-bnb.vercel.app/a', 'https://bscscan.com/tx/0x1'],
    source_class: ['marketplace', 'independent'],
    source_party: ['marketplace', 'respondent'],
    bond: '100000000000000000',
    extensions: 1,
    opened_at: 1_767_225_600,
    answer_end: 1_767_312_000,
    window_end: 1_767_830_400,
    verdict: '',
  };

  it('maps the contract vocabulary onto Bench types', () => {
    const d = decodeDispute(7, raw, 'bench-bnb.vercel.app');
    expect(d.disputeId).toBe(7);
    expect(d.ground).toBe('breach');
    expect(d.state).toBe('upheld');
    expect(d.bond).toBe(100_000_000_000_000_000n);
    expect(d.openedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(d.verdict).toBeNull();
  });

  it('keeps the contract’s own classification of each source', () => {
    /**
     * Re-deriving a class the contract already assigned would let Bench's view
     * of who owns a source diverge from the one the ruling was made under - and
     * Bench is the party with the most to gain from an answer of
     * `independent`.
     */
    const d = decodeDispute(7, raw, 'bench-bnb.vercel.app');
    expect(d.sources.map((s) => s.origin)).toEqual(['marketplace', 'independent']);
  });
});
