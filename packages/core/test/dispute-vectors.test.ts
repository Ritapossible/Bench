import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  hireIdOf,
  hireKey,
  registrarOf,
  replayAgainstTerms,
  type DisputedAction,
} from '../src/types/dispute.js';
import type { BehaviouralEnvelope, EnvelopePolicy } from '../src/types/envelope.js';
import type { HireMandate } from '../src/types/mandate.js';
import type { Address, Hex } from '../src/types/primitives.js';

/**
 * The other half of the conformance check.
 *
 * `contracts/genlayer/tests/test_vectors.py` asserts that the Arbiter's Python
 * replay reproduces these answers. This file asserts that the TypeScript still
 * produces them - without it, the vectors are whatever the TypeScript happened
 * to say the last time someone regenerated them, and a change here would
 * silently move the target the Python is aiming at instead of failing.
 *
 * Two implementations, one rulebook, one file they are both held to. The
 * duplication exists because the ruling must not be computed by Bench: Bench
 * lists the agent, ranks it, and takes a cut of the hire.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const VECTORS = join(HERE, '..', '..', '..', 'contracts', 'genlayer', 'tests', 'vectors.json');

interface Vector {
  readonly name: string;
  readonly why: string;
  readonly terms: {
    readonly mandate: {
      readonly total_cap: string;
      readonly per_tx_cap: string;
      readonly allowlist: readonly string[];
      readonly expires_at: number;
      readonly max_actions: number;
      readonly token: string;
      readonly revoked_at?: number;
    };
    readonly envelope: {
      readonly recipients: readonly string[];
      readonly selectors: readonly string[];
      readonly max_single_value: string;
      readonly max_cumulative_value: string;
      readonly max_action_count: number;
      readonly sample_size: number;
    };
    readonly policy: {
      readonly value_tolerance_bps: number;
      readonly action_tolerance_bps: number;
      readonly require_known_recipient: boolean;
      readonly require_known_selector: boolean;
    };
  };
  readonly actions: readonly {
    readonly seq: number;
    readonly at: number;
    readonly to: string | null;
    readonly value: string;
    readonly data: string;
    readonly token?: string;
  }[];
  readonly terms_hash: string;
  readonly expect: {
    readonly findings: readonly { readonly rule: string; readonly seq: number }[];
    readonly envelope_advisory: boolean;
    readonly actions_considered: number;
  };
}

interface KeyVector {
  readonly registrar: string;
  readonly hire_id: string;
  readonly key: string;
  readonly round_trip: string;
}

const file = JSON.parse(readFileSync(VECTORS, 'utf8')) as {
  readonly version: number;
  readonly cases: readonly Vector[];
  readonly keys: readonly KeyVector[];
};

const mandateOf = (v: Vector): HireMandate => ({
  id: 'm-vector',
  version: 1,
  hireId: 'h-vector',
  owner: `0x${'11'.repeat(20)}` as Address,
  agent: { chain: 'bsc-mainnet', tokenId: 1n },
  sessionKey: `0x${'22'.repeat(20)}` as Address,
  bounds: {
    totalSpendCap: {
      token: v.terms.mandate.token as Address,
      symbol: 'T',
      decimals: 18,
      amount: BigInt(v.terms.mandate.total_cap),
    },
    perTxCap: {
      token: v.terms.mandate.token as Address,
      symbol: 'T',
      decimals: 18,
      amount: BigInt(v.terms.mandate.per_tx_cap),
    },
    contractAllowlist: v.terms.mandate.allowlist as readonly Address[],
    expiresAt: new Date(v.terms.mandate.expires_at * 1000),
    maxActions: v.terms.mandate.max_actions,
  },
  nonce: '0x00' as Hex,
  issuedAt: new Date(0),
});

const envelopeOf = (v: Vector): BehaviouralEnvelope => ({
  recipients: v.terms.envelope.recipients as readonly Address[],
  selectors: v.terms.envelope.selectors as readonly Hex[],
  maxSingleValueWei: BigInt(v.terms.envelope.max_single_value),
  maxCumulativeValueWei: BigInt(v.terms.envelope.max_cumulative_value),
  maxActionCount: v.terms.envelope.max_action_count,
  maxPositionDropUsd: null,
  sampleSize: v.terms.envelope.sample_size,
});

const policyOf = (v: Vector): EnvelopePolicy => ({
  valueToleranceBps: v.terms.policy.value_tolerance_bps,
  actionToleranceBps: v.terms.policy.action_tolerance_bps,
  requireKnownRecipient: v.terms.policy.require_known_recipient,
  requireKnownSelector: v.terms.policy.require_known_selector,
});

const actionsOf = (v: Vector): DisputedAction[] =>
  v.actions.map((a) => ({
    seq: a.seq,
    at: new Date(a.at * 1000),
    to: a.to === null ? null : (a.to as Address),
    value: BigInt(a.value),
    data: a.data as Hex,
    decoded: null,
    simulated: { success: true, gasUsed: 21_000n },
    ...(a.token === undefined ? {} : { token: a.token as Address }),
  }));

/** Matches `canonical_json` in the contract and `canonicalJson` in the adapter. */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

describe('dispute conformance vectors', () => {
  it('has a vector file in the format both readers expect', () => {
    expect(file.version).toBe(1);
    expect(file.cases.length).toBeGreaterThan(10);
  });

  it('agrees with the contract on how terms are digested', () => {
    /**
     * `adjudicate` refuses unless the terms it is handed hash to what was
     * pinned at hire time. Two encoders that disagree make every adjudication
     * fail as "terms do not match the digest recorded at hire time" - which
     * reads as a party rewriting the deal and is really a codec disagreeing
     * with itself across a language boundary.
     */
    for (const v of file.cases) {
      expect(
        createHash('sha256').update(canonicalJson(v.terms), 'utf8').digest('hex'),
        v.name,
      ).toBe(v.terms_hash);
    }
  });

  for (const v of file.cases) {
    it(`still produces: ${v.name}`, () => {
      const audit = replayAgainstTerms(
        actionsOf(v),
        mandateOf(v),
        envelopeOf(v),
        policyOf(v),
        v.terms.mandate.revoked_at === undefined
          ? null
          : new Date(v.terms.mandate.revoked_at * 1000),
      );
      expect(
        audit.findings.map((f) => ({ rule: f.rule as string, seq: f.seq })),
        v.why,
      ).toEqual(v.expect.findings.map((f) => ({ rule: f.rule, seq: f.seq })));
      expect(audit.envelopeAdvisory).toBe(v.expect.envelope_advisory);
      expect(audit.actionsConsidered).toBe(v.expect.actions_considered);
    });
  }
});

describe('the hire key', () => {
  /**
   * The one divergence that would not raise.
   *
   * A terms digest computed differently across the boundary fails loudly:
   * `adjudicate` refuses and says the terms do not match. A *key* computed
   * differently fails silently - Bench writes one row and reads another,
   * `disputes_for` answers with an empty list, and the hire page renders "no
   * dispute" over a hire that has one. So it gets a vector too.
   */
  for (const k of file.keys) {
    it(`matches the Python for ${k.hire_id}`, () => {
      expect(hireKey(k.registrar, k.hire_id)).toBe(k.key);
      expect(registrarOf(k.key)).toBe(k.registrar.toLowerCase());
      // An id containing a separator of its own must survive the round trip:
      // both sides split once, at the first slash, and never on the last.
      expect(hireIdOf(k.key)).toBe(k.round_trip);
      expect(hireIdOf(k.key)).toBe(k.hire_id);
    });
  }
});
