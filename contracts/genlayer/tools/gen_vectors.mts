/**
 * Generate the conformance vectors both rulebooks are held to.
 *
 *     npx tsx contracts/genlayer/tools/gen_vectors.mts
 *
 * The Arbiter reimplements `replayAgainstTerms` in Python because the ruling
 * must not be computed by Bench - Bench lists the agent, ranks it and takes a
 * cut, and a marketplace adjudicating its own listings is marking its own
 * homework. That leaves two implementations of one rulebook, which is how
 * implementations drift until one of them is quietly wrong.
 *
 * So: the cases below are run through the TypeScript, the answers are written
 * to `tests/vectors.json`, and both suites assert against that file.
 * `packages/core/test/dispute-vectors.test.ts` fails if the TypeScript stops
 * producing them; `contracts/genlayer/tests/test_vectors.py` fails if the
 * Python does not reproduce them. A change to either rulebook that the other
 * does not follow fails on both sides, in CI, before it reaches a chain.
 *
 * Two mismatches were already found this way and are pinned below: the action
 * ceiling rounds up while the value ceiling rounds down, and revocation is a
 * moment in time rather than a flag.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hireIdOf, hireKey, replayAgainstTerms } from '../../../packages/core/src/types/dispute.js';
import type { DisputedAction } from '../../../packages/core/src/types/dispute.js';
import type {
  BehaviouralEnvelope,
  EnvelopePolicy,
} from '../../../packages/core/src/types/envelope.js';
import type { HireMandate } from '../../../packages/core/src/types/mandate.js';
import type { Address, Hex } from '../../../packages/core/src/types/primitives.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'tests', 'vectors.json');

const POOL = `0x${'33'.repeat(20)}` as Address;
const STRANGER = `0x${'99'.repeat(20)}` as Address;
const TOKEN = `0x${'55'.repeat(20)}` as Address;
const OTHER_TOKEN = `0x${'66'.repeat(20)}` as Address;
const SWAP = '0x38ed1739' as Hex;
const UNKNOWN_CALL = '0xdeadbeef' as Hex;

const T0 = 1_767_225_600; // 2026-01-01T00:00:00Z, in seconds
const sec = (offset: number): number => T0 + offset;

interface Case {
  readonly name: string;
  readonly why: string;
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
  readonly actions: readonly {
    readonly seq: number;
    readonly at: number;
    readonly to: string | null;
    readonly value: string;
    readonly data: string;
    readonly token?: string;
  }[];
}

const baseMandate = {
  total_cap: (10n ** 18n).toString(),
  per_tx_cap: (5n * 10n ** 17n).toString(),
  allowlist: [POOL.toLowerCase()],
  expires_at: sec(3600),
  max_actions: 5,
  token: TOKEN.toLowerCase(),
};

const baseEnvelope = {
  recipients: [POOL.toLowerCase()],
  selectors: [SWAP],
  max_single_value: (2n * 10n ** 17n).toString(),
  max_cumulative_value: (6n * 10n ** 17n).toString(),
  max_action_count: 3,
  sample_size: 3,
};

const basePolicy = {
  value_tolerance_bps: 5_000,
  action_tolerance_bps: 10_000,
  require_known_recipient: true,
  require_known_selector: true,
};

const act = (
  seq: number,
  over: Partial<Case['actions'][number]> = {},
): Case['actions'][number] => ({
  seq,
  at: sec(seq * 60),
  to: POOL.toLowerCase(),
  value: (10n ** 17n).toString(),
  data: SWAP,
  ...over,
});

const CASES: readonly Case[] = [
  {
    name: 'clean hire',
    why: 'The baseline. Everything inside every bound, and no finding at all.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1), act(2)],
  },
  {
    name: 'payment to an address nobody authorised',
    why: 'Caught twice over - by the allowlist the owner signed and by the behaviour the agent earned. Two independent bounds firing on one action is the design working, not a duplicate.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1), act(2, { to: STRANGER.toLowerCase() })],
  },
  {
    name: 'contract creation',
    why: 'A null recipient is off the allowlist by definition, and the envelope check skips it rather than reporting an unseen recipient that does not exist.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1, { to: null })],
  },
  {
    name: 'cap blown cumulatively, never per transaction',
    why: 'Each action is comfortably inside the per-tx cap. Only the running total catches it, which is the case a per-transaction limit alone would miss entirely.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [
      act(1, { value: (4n * 10n ** 17n).toString() }),
      act(2, { value: (4n * 10n ** 17n).toString() }),
      act(3, { value: (4n * 10n ** 17n).toString() }),
    ],
  },
  {
    name: 'spend keeps counting after the first breach',
    why: 'A replay that skipped the offending action would under-count the total and clear a hire that blew its cap on the transaction after the one that first went wrong.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [
      act(1, { to: STRANGER.toLowerCase(), value: (9n * 10n ** 17n).toString() }),
      act(2, { value: (2n * 10n ** 17n).toString() }),
    ],
  },
  {
    name: 'expiry is judged by the clock at the time',
    why: 'The second action lands after the mandate expired. The first does not, and a replay against the clock at adjudication would find a breach in every hire that ever completed.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1), act(2, { at: sec(7200) })],
  },
  {
    name: 'spending after the kill switch',
    why: 'The breach a hirer is angriest about. Revocation is a moment, not a flag: the action before it was authorised and the one after it was not.',
    mandate: { ...baseMandate, revoked_at: sec(90) },
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1), act(2)],
  },
  {
    name: 'a call the agent never made in audition',
    why: 'The selector is the sharpest signal of a compromised or injected agent: it is doing something it has never done.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1, { data: UNKNOWN_CALL })],
  },
  {
    name: 'the wrong token entirely',
    why: 'A mandate denominated in one token does not authorise spending another.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [act(1, { token: OTHER_TOKEN.toLowerCase() })],
  },
  {
    name: 'action ceiling rounds up',
    why: 'Three observed actions at 50% tolerance is a ceiling of five, because the TypeScript takes Math.ceil(4.5). Floor division would say four and a four-action hire would pass the gate and be found in breach by the chain. This case exists because that mismatch was real.',
    mandate: { ...baseMandate, max_actions: 99 },
    envelope: { ...baseEnvelope, max_action_count: 3 },
    policy: { ...basePolicy, action_tolerance_bps: 5_000 },
    actions: [act(1), act(2), act(3), act(4), act(5)],
  },
  {
    name: 'value ceiling rounds down',
    why: 'The paired half of the case above: value tolerance truncates, because the TypeScript computes it in BigInt. 3 wei at 50% is a ceiling of 4, not 5.',
    mandate: { ...baseMandate, per_tx_cap: '1000', total_cap: '1000' },
    envelope: { ...baseEnvelope, max_single_value: '3', max_cumulative_value: '1000' },
    policy: { ...basePolicy, value_tolerance_bps: 5_000 },
    actions: [act(1, { value: '4' }), act(2, { value: '5' })],
  },
  {
    name: 'thin envelope still reports, still cannot bind',
    why: 'One audition is not a behavioural record. The envelope rules are reported and the audit says they are advisory; only the mandate the owner signed can settle a dispute.',
    mandate: baseMandate,
    envelope: { ...baseEnvelope, sample_size: 1 },
    policy: basePolicy,
    actions: [act(1, { to: STRANGER.toLowerCase() })],
  },
  {
    name: 'policy switched off',
    why: 'With both behavioural checks disabled only the signed mandate speaks. Nothing should invent a rule the policy declined to apply.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: {
      ...basePolicy,
      require_known_recipient: false,
      require_known_selector: false,
    },
    actions: [act(1, { to: STRANGER.toLowerCase(), data: UNKNOWN_CALL })],
  },
  {
    name: 'out of order arrives in order',
    why: 'The record is read by sequence number, not by however it was handed over. Cumulative rules depend on order, so a shuffled record must not produce a different answer.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [
      act(3, { value: (4n * 10n ** 17n).toString() }),
      act(1),
      act(2, { value: (4n * 10n ** 17n).toString() }),
    ],
  },
  {
    name: 'empty record',
    why: 'Nothing happened, so nothing was breached. The ruling this maps to is unresolved rather than dismissed, but that is the contract’s decision and not the replay’s.',
    mandate: baseMandate,
    envelope: baseEnvelope,
    policy: basePolicy,
    actions: [],
  },
];

const toMandate = (c: Case): HireMandate => ({
  id: 'm-vector',
  version: 1,
  hireId: 'h-vector',
  owner: `0x${'11'.repeat(20)}` as Address,
  agent: { chain: 'bsc-mainnet', tokenId: 1n },
  sessionKey: `0x${'22'.repeat(20)}` as Address,
  bounds: {
    totalSpendCap: {
      token: c.mandate.token as Address,
      symbol: 'T',
      decimals: 18,
      amount: BigInt(c.mandate.total_cap),
    },
    perTxCap: {
      token: c.mandate.token as Address,
      symbol: 'T',
      decimals: 18,
      amount: BigInt(c.mandate.per_tx_cap),
    },
    contractAllowlist: c.mandate.allowlist as readonly Address[],
    expiresAt: new Date(c.mandate.expires_at * 1000),
    maxActions: c.mandate.max_actions,
  },
  nonce: '0x00' as Hex,
  issuedAt: new Date(T0 * 1000),
});

const toEnvelope = (c: Case): BehaviouralEnvelope => ({
  recipients: c.envelope.recipients as readonly Address[],
  selectors: c.envelope.selectors as readonly Hex[],
  maxSingleValueWei: BigInt(c.envelope.max_single_value),
  maxCumulativeValueWei: BigInt(c.envelope.max_cumulative_value),
  maxActionCount: c.envelope.max_action_count,
  maxPositionDropUsd: null,
  sampleSize: c.envelope.sample_size,
});

const toPolicy = (c: Case): EnvelopePolicy => ({
  valueToleranceBps: c.policy.value_tolerance_bps,
  actionToleranceBps: c.policy.action_tolerance_bps,
  requireKnownRecipient: c.policy.require_known_recipient,
  requireKnownSelector: c.policy.require_known_selector,
});

const toActions = (c: Case): DisputedAction[] =>
  c.actions.map((a) => ({
    seq: a.seq,
    at: new Date(a.at * 1000),
    to: a.to === null ? null : (a.to as Address),
    value: BigInt(a.value),
    data: a.data as Hex,
    decoded: null,
    simulated: { success: true, gasUsed: 21_000n },
    ...(a.token === undefined ? {} : { token: a.token as Address }),
  }));

/**
 * Canonical JSON, matching `canonical_json` in the contract exactly.
 *
 * Duplicated here rather than imported from the adapter because this generator
 * must not depend on the package it is validating - and because the value it
 * produces, `terms_hash`, is the one thing that makes a dispute adjudicable at
 * all. A digest computed differently on either side reads on-chain as someone
 * restating the terms after the hire went wrong, and the contract refuses.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
};

const cases = CASES.map((c) => {
  const audit = replayAgainstTerms(
    toActions(c),
    toMandate(c),
    toEnvelope(c),
    toPolicy(c),
    c.mandate.revoked_at === undefined ? null : new Date(c.mandate.revoked_at * 1000),
  );
  const terms = { mandate: c.mandate, envelope: c.envelope, policy: c.policy };
  return {
    name: c.name,
    why: c.why,
    terms,
    // Asserted by both suites. If these ever differ, no dispute on either side
    // can be adjudicated, and the failure surfaces as "terms do not match the
    // digest recorded at hire time" - which sounds like fraud and is a codec.
    terms_hash: createHash('sha256').update(canonicalJson(terms), 'utf8').digest('hex'),
    actions: c.actions,
    expect: {
      findings: audit.findings.map((f) => ({ rule: f.rule, seq: f.seq })),
      envelope_advisory: audit.envelopeAdvisory,
      actions_considered: audit.actionsConsidered,
    },
  };
});

/**
 * The hire key, which is access control rather than arithmetic.
 *
 * Small enough to look like it does not need a vector, and the one place where
 * a silent divergence is worst: the two sides would not error, they would
 * address different rows. Bench would write a hire the contract could not find
 * and every dispute page would render "no dispute" over a hire that had one.
 *
 * Checksummed casing, a registrar that is already lower case, and an id
 * carrying a slash of its own - the last because the contract splits on the
 * first separator and a naive round trip would eat half the id.
 */
const KEY_CASES = [
  { registrar: `0x${'AB'.repeat(20)}`, hire_id: 'h_01JQZ9' },
  { registrar: `0x${'ab'.repeat(20)}`, hire_id: 'h_01JQZ9' },
  { registrar: `0x${'12'.repeat(20)}`, hire_id: 'weird/id' },
].map((c) => ({
  ...c,
  key: hireKey(c.registrar, c.hire_id),
  round_trip: hireIdOf(hireKey(c.registrar, c.hire_id)),
}));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  `${JSON.stringify(
    {
      version: 1,
      generated_by: 'contracts/genlayer/tools/gen_vectors.mts',
      note: 'Do not hand-edit. Regenerate, and expect both test suites to move together.',
      cases,
      keys: KEY_CASES,
    },
    null,
    2,
  )}\n`,
  'utf8',
);
console.log(`wrote ${cases.length} cases to ${OUT}`);
for (const c of cases) {
  const rules = c.expect.findings.map((f) => `${f.rule}@${f.seq}`).join(', ') || '(clean)';
  console.log(`  ${c.name}: ${rules}`);
}
