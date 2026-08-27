import { formatBaseUnits } from './primitives.js';
import type { InterceptedAction } from './audition.js';
import type { Address, Hex } from './primitives.js';

/**
 * Behavioural envelopes — ARCHITECTURE.md 2.1.
 *
 * A spend cap answers *how much*. It does nothing about an agent doing
 * something ruinous with an amount well inside the cap. But the audition has
 * already established what this agent does to a position of this shape, so
 * that record can be turned into a bound and put in the signing path.
 *
 * Everything here is pure and dependency-free, for the same reason
 * `isVerifiedLive` is: the gate is a claim Bench makes publicly, so it has
 * exactly one definition, and the web app, the worker and the signer cannot
 * drift into three different notions of what "in policy" means.
 */

/** A rule that can refuse a transaction. Named, because a refusal must be explainable. */
export type EnvelopeRule =
  | 'unseen-recipient'
  | 'unseen-call'
  | 'value-exceeds-observed'
  | 'cumulative-value-exceeds-observed'
  | 'action-count-exceeds-observed'
  | 'position-drop-exceeds-observed';

/**
 * What an agent was observed doing across its auditions.
 *
 * Derived, never authored: a human writing this by hand would be guessing,
 * which is the thing the gate exists to replace.
 */
export interface BehaviouralEnvelope {
  /** Contracts and accounts the agent sent to. Lowercased for comparison. */
  readonly recipients: readonly Address[];
  /** 4-byte selectors it called. A bare value transfer contributes '0x'. */
  readonly selectors: readonly Hex[];
  readonly maxSingleValueWei: bigint;
  readonly maxCumulativeValueWei: bigint;
  readonly maxActionCount: number;
  /** Worst position drawdown observed, in USD. Null when no outcome was recorded. */
  readonly maxPositionDropUsd: number | null;
  /** Auditions behind this envelope. One run is not a behavioural record. */
  readonly sampleSize: number;
}

/**
 * How much slack to allow around what was observed.
 *
 * An envelope pinned to the exact observed maximum would refuse almost every
 * legitimate transaction — the agent that moved at most 0.4 BNB in audition
 * will eventually need 0.41. Tolerance is what makes the gate a safety bound
 * rather than a straitjacket, and it is stated here rather than scattered
 * across call sites so the number is quotable.
 */
export interface EnvelopePolicy {
  /** Headroom over observed value maxima, in basis points. 5_000 = allow 1.5x. */
  readonly valueToleranceBps: number;
  /** Headroom over the observed action count, in basis points. */
  readonly actionToleranceBps: number;
  /**
   * Whether an address never seen in audition is refused.
   *
   * Defaults to true, and this is the rule that carries most of the value:
   * an agent that has been compromised or prompt-injected shows up first as a
   * transfer to somewhere it has never sent funds before.
   */
  readonly requireKnownRecipient: boolean;
  /** Whether a selector never seen in audition is refused. */
  readonly requireKnownSelector: boolean;
}

export const DEFAULT_ENVELOPE_POLICY: EnvelopePolicy = {
  valueToleranceBps: 5_000,
  actionToleranceBps: 10_000,
  requireKnownRecipient: true,
  requireKnownSelector: true,
};

/**
 * Below this many auditions an envelope is too thin to enforce.
 *
 * Refusing on one run's worth of behaviour would block a perfectly good agent
 * the first time it does anything slightly different. Callers should treat a
 * thin envelope as advisory — record the decision, do not act on it.
 */
export const MIN_ENVELOPE_SAMPLE = 3;

export const isEnvelopeThin = (e: BehaviouralEnvelope): boolean => e.sampleSize < MIN_ENVELOPE_SAMPLE;

/** A transaction the hired agent wants to send, before it is signed. */
export interface CandidateAction {
  readonly to: Address | null;
  readonly value: bigint;
  readonly data: Hex;
  /** Value this agent has already moved during the live hire. */
  readonly cumulativeValueWei: bigint;
  /** Actions this agent has already taken during the live hire. */
  readonly priorActionCount: number;
  /** Simulated position value change, when the caller has simulated it. */
  readonly simulatedPositionDropUsd?: number;
}

export interface GateDecision {
  readonly allowed: boolean;
  /** Every rule that fired, not just the first — a refusal should be complete. */
  readonly rules: readonly EnvelopeRule[];
  /** Human-readable, for the hire card. Empty when allowed. */
  readonly explanation: string;
  /** True when the envelope was too thin to enforce; decision is advisory. */
  readonly advisory: boolean;
}

const selectorOf = (data: Hex): Hex =>
  (data.length >= 10 ? (data.slice(0, 10).toLowerCase() as Hex) : ('0x' as Hex));

const withTolerance = (v: bigint, bps: number): bigint => (v * BigInt(10_000 + bps)) / 10_000n;

/**
 * Envelope maxima are native-token base units, and a refusal is read by a
 * person deciding whether their agent misbehaved. "170000000000000000000 wei"
 * is not a quantity anyone can weigh against another one at a glance, which
 * makes the most important sentence in the trace the least legible.
 */
const native = (v: bigint): string => `${formatBaseUnits(v, 18)} BNB`;

/**
 * Fold audition activity into an envelope.
 *
 * `runs` is one entry per audition: the actions the agent took, and the
 * position drop that resulted. Passing them separately rather than as a flat
 * action list is deliberate — per-run maxima are what bound a *hire*, and
 * flattening would let a ten-action run and a one-action run average into a
 * bound that describes neither.
 */
export function deriveEnvelope(
  runs: readonly { readonly actions: readonly InterceptedAction[]; readonly positionDropUsd?: number }[],
): BehaviouralEnvelope {
  const recipients = new Set<Address>();
  const selectors = new Set<Hex>();
  let maxSingleValueWei = 0n;
  let maxCumulativeValueWei = 0n;
  let maxActionCount = 0;
  let maxPositionDropUsd: number | null = null;

  for (const run of runs) {
    let cumulative = 0n;
    for (const a of run.actions) {
      if (a.to !== null) recipients.add(a.to.toLowerCase() as Address);
      selectors.add(selectorOf(a.data));
      if (a.value > maxSingleValueWei) maxSingleValueWei = a.value;
      cumulative += a.value;
    }
    if (cumulative > maxCumulativeValueWei) maxCumulativeValueWei = cumulative;
    if (run.actions.length > maxActionCount) maxActionCount = run.actions.length;
    if (run.positionDropUsd !== undefined) {
      maxPositionDropUsd = maxPositionDropUsd === null
        ? run.positionDropUsd
        : Math.max(maxPositionDropUsd, run.positionDropUsd);
    }
  }

  return {
    recipients: [...recipients],
    selectors: [...selectors],
    maxSingleValueWei,
    maxCumulativeValueWei,
    maxActionCount,
    maxPositionDropUsd,
    sampleSize: runs.length,
  };
}

/**
 * The gate itself.
 *
 * Pure, total, and synchronous: whatever simulates the transaction does so
 * before calling this, so the decision can be unit-tested exhaustively and
 * recomputed later from a stored candidate without a fork.
 */
export function checkAgainstEnvelope(
  candidate: CandidateAction,
  envelope: BehaviouralEnvelope,
  policy: EnvelopePolicy = DEFAULT_ENVELOPE_POLICY,
): GateDecision {
  const rules: EnvelopeRule[] = [];

  if (policy.requireKnownRecipient && candidate.to !== null) {
    if (!envelope.recipients.includes(candidate.to.toLowerCase() as Address)) {
      rules.push('unseen-recipient');
    }
  }

  if (policy.requireKnownSelector) {
    if (!envelope.selectors.includes(selectorOf(candidate.data))) {
      rules.push('unseen-call');
    }
  }

  if (candidate.value > withTolerance(envelope.maxSingleValueWei, policy.valueToleranceBps)) {
    rules.push('value-exceeds-observed');
  }

  const cumulative = candidate.cumulativeValueWei + candidate.value;
  if (cumulative > withTolerance(envelope.maxCumulativeValueWei, policy.valueToleranceBps)) {
    rules.push('cumulative-value-exceeds-observed');
  }

  const actionCeiling = Math.ceil(
    (envelope.maxActionCount * (10_000 + policy.actionToleranceBps)) / 10_000,
  );
  if (candidate.priorActionCount + 1 > actionCeiling) {
    rules.push('action-count-exceeds-observed');
  }

  if (
    candidate.simulatedPositionDropUsd !== undefined &&
    envelope.maxPositionDropUsd !== null &&
    candidate.simulatedPositionDropUsd >
      envelope.maxPositionDropUsd * (1 + policy.valueToleranceBps / 10_000)
  ) {
    rules.push('position-drop-exceeds-observed');
  }

  const advisory = isEnvelopeThin(envelope);

  return {
    allowed: rules.length === 0,
    rules,
    explanation: rules.length === 0 ? '' : explain(rules, candidate, envelope),
    advisory,
  };
}

function explain(
  rules: readonly EnvelopeRule[],
  c: CandidateAction,
  e: BehaviouralEnvelope,
): string {
  const parts = rules.map((r) => {
    switch (r) {
      case 'unseen-recipient':
        return `sends to ${c.to ?? 'contract creation'}, which this agent never touched in ${e.sampleSize} auditions`;
      case 'unseen-call':
        return `calls ${selectorOf(c.data)}, a function this agent never called in audition`;
      case 'value-exceeds-observed':
        return `moves ${native(c.value)}; the most it moved in any single audition action was ${native(e.maxSingleValueWei)}`;
      case 'cumulative-value-exceeds-observed':
        return `would take this hire to ${native(c.cumulativeValueWei + c.value)} moved; the most in any audition was ${native(e.maxCumulativeValueWei)}`;
      case 'action-count-exceeds-observed':
        return `is action ${c.priorActionCount + 1}; the most it took in any audition was ${e.maxActionCount}`;
      case 'position-drop-exceeds-observed':
        return `would drop the position by $${c.simulatedPositionDropUsd?.toFixed(2)}; the worst audition drawdown was $${e.maxPositionDropUsd?.toFixed(2)}`;
      default: {
        const exhaustive: never = r;
        return String(exhaustive);
      }
    }
  });
  return `Refused: the transaction ${parts.join('; and ')}.`;
}
