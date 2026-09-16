import { DEFAULT_ENVELOPE_POLICY } from '../types/envelope.js';
import { atSeconds } from '../types/dispute.js';
import type { AgentId } from '../types/agent.js';
import type { Address } from '../types/primitives.js';
import type { HireRecord } from './hire-store.js';
import type {
  ActionRecord,
  DisputeGround,
  DisputeState,
  EvidenceIndependence,
  EvidenceSource,
} from '../types/dispute.js';

/**
 * The adjudicator, as a port.
 *
 * A port rather than a direct client because the implementation is a chain
 * Bench does not run, and the property that matters - that the ruling is not
 * computed by the marketplace - is exactly the property a stub quietly
 * destroys. So the two adapters are deliberately asymmetric: one talks to
 * GenLayer, the other **refuses every call**. There is no in-memory arbiter
 * that returns a plausible verdict, because a plausible verdict from Bench is
 * the failure this whole layer exists to prevent, and it is precisely what a
 * demo would ship by accident.
 */

/** What a hire commits to before anything goes wrong. */
export interface DisputeTerms {
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
}

/**
 * The terms of a hire, in the exact shape the arbiter pins and replays.
 *
 * **One function, used at registration and at adjudication.** The contract
 * refuses to rule unless the terms it is handed hash to the digest recorded at
 * hire time, so two call sites building this structure independently would not
 * produce a bug that looks like a bug - it would produce "terms do not match
 * the digest recorded at hire time", which reads as a party rewriting the deal.
 *
 * `revoked_at` is deliberately absent. Terms are pinned before anyone knows
 * there will be a dispute; revocation happens afterwards, so a revocation
 * inside the digest would be either always empty or a value that changes after
 * the digest was taken. It travels in the published action record instead,
 * where it belongs - it is something that happened, not something agreed.
 */
export function disputeTermsFor(hire: HireRecord): DisputeTerms {
  const b = hire.mandate.bounds;
  const policy = hire.envelopePolicy ?? DEFAULT_ENVELOPE_POLICY;
  return {
    mandate: {
      total_cap: b.totalSpendCap.amount.toString(),
      per_tx_cap: b.perTxCap.amount.toString(),
      allowlist: b.contractAllowlist.map((a) => a.toLowerCase()),
      expires_at: atSeconds(b.expiresAt),
      max_actions: b.maxActions,
      token: b.totalSpendCap.token.toLowerCase(),
    },
    envelope: {
      recipients: hire.envelope.recipients.map((a) => a.toLowerCase()),
      selectors: hire.envelope.selectors.map((sel) => sel.toLowerCase()),
      max_single_value: hire.envelope.maxSingleValueWei.toString(),
      max_cumulative_value: hire.envelope.maxCumulativeValueWei.toString(),
      max_action_count: hire.envelope.maxActionCount,
      sample_size: hire.envelope.sampleSize,
    },
    policy: {
      value_tolerance_bps: policy.valueToleranceBps,
      action_tolerance_bps: policy.actionToleranceBps,
      require_known_recipient: policy.requireKnownRecipient,
      require_known_selector: policy.requireKnownSelector,
    },
  };
}

/**
 * The action record Bench publishes at the URL it pinned at hire time.
 *
 * This is the one piece of the breach ground Bench is still responsible for,
 * and the arbiter treats it accordingly: it is classified `marketplace` rather
 * than `independent`, every published copy has to agree or the dispute goes
 * unresolved, and the remedy against a doctored record is for the other side to
 * publish its own. Bench publishing nothing at all is not neutrality - it makes
 * every breach dispute unresolvable, which quietly favours whoever holds the
 * money.
 */
export function actionRecordFor(hire: HireRecord): ActionRecord {
  const revoked = hire.mandateState.revokedAt;
  return {
    hire_id: hire.id,
    actions: hire.actions ?? [],
    revoked_at: revoked === null || revoked === undefined ? null : atSeconds(revoked),
  };
}

export interface HireRegistration {
  readonly hireId: string;
  readonly agent: AgentId;
  /** Who may open a dispute. A wallet, or another agent's key. */
  readonly client: Address;
  /** Who answers it. The agent's operator. */
  readonly respondent: Address;
  readonly terms: DisputeTerms;
  /**
   * Where the action record will be published.
   *
   * Pinned at hire time, before anyone knows there will be a dispute, so the
   * claimant cannot choose a flattering source after the fact. It is still only
   * evidence: its likeliest publisher is Bench, the arbiter classifies it as
   * `marketplace`, and the respondent's remedy against a doctored record is to
   * publish its own.
   */
  readonly recordUrl: string;
  readonly claimantDomain?: string;
  readonly respondentDomain?: string;
  readonly marketplaceDomain?: string;
}

export interface DisputeFiling {
  readonly hireId: string;
  readonly ground: DisputeGround;
  /** What the agent was hired to do, in the hirer's own words. */
  readonly engagement: string;
  /** Numbered statements the arbiter will read the evidence against. */
  readonly criteria: readonly string[];
  readonly evidenceUrls: readonly string[];
  /** The filing bond, in the arbiter chain's base units. */
  readonly bond: bigint;
}

export interface DisputeRecord {
  readonly disputeId: number;
  readonly hireId: string;
  readonly ground: DisputeGround;
  readonly state: DisputeState;
  /**
   * Who filed and posted the bond, which is who the bond returns to.
   *
   * Not necessarily the hire's client. Crediting a refund to a party that never
   * paid would strand it on an address with no key behind it - precisely what a
   * marketplace's per-browser client id is.
   */
  readonly claimant: Address;
  /**
   * Whose dispute it is: the client named when the terms were pinned.
   *
   * Equal to `claimant` when the client filed for itself, different when the
   * registrar filed on its behalf. Stored on the chain rather than inferred, so
   * a reader never has to guess which of the two happened.
   */
  readonly onBehalfOf: Address;
  readonly respondent: Address;
  readonly criteria: readonly string[];
  readonly sources: readonly EvidenceSource[];
  readonly bond: bigint;
  readonly extensions: number;
  readonly openedAt: Date;
  /** Until this moment only the respondent may file, and nobody may rule. */
  readonly answerEndsAt: Date;
  readonly windowEndsAt: Date;
  /** The arbiter's own record of the ruling, or null before one. */
  readonly verdict: DisputeVerdictRecord | null;
}

export interface DisputeVerdictRecord {
  readonly ruling: 'upheld' | 'dismissed' | 'unresolved';
  readonly resolvedBy: 'replay' | 'model';
  readonly criteria: readonly {
    readonly id: number;
    readonly status: 'met' | 'unmet' | 'unresolved';
    readonly confidence: number;
  }[];
  readonly sourcesReachable: number;
  readonly evidence: EvidenceIndependence;
  /**
   * The leader's working: findings for a replay, quotes for a model call.
   *
   * Never compared during consensus and carries no guarantee, which is why it
   * is quarantined under one name rather than spread across the record. It is
   * also the most useful thing here for a person asking why a dispute went the
   * way it did.
   */
  readonly observed: Readonly<Record<string, unknown>> | null;
}

/**
 * A hire as the arbiter holds it, or `null` when it holds none.
 *
 * The distinction is the whole of what a hire page needs to say. An unpinned
 * hire cannot be disputed at all - `open_dispute` refuses with "hire not
 * registered" - and offering a filing form over one would cost the hirer a
 * transaction to be told no at the moment they are angriest.
 */
export interface PinnedHire {
  readonly hireId: string;
  readonly agentRef: string;
  readonly client: Address;
  readonly respondent: Address;
  readonly termsHash: string;
  /** Where the action record is published. Pinned before anyone knew. */
  readonly recordUrl: string;
  readonly registeredAt: Date;
  readonly registeredBy: Address;
}

/** The arbiter's construction-time bounds, as a UI needs them. */
export interface DisputeLimits {
  /** Below this a filing is refused. The form must not offer less. */
  readonly minBond: bigint;
  /** Seconds the respondent gets before anyone may rule. */
  readonly answerPeriodSec: number;
  readonly claimPeriodSec: number;
  readonly maxSources: number;
  readonly maxExtensions: number;
  /** Below this an `unmet` reading is downgraded to `unresolved`. */
  readonly minConfidence: number;
}

export interface DisputeResolver {
  /** True when an arbiter is actually configured. Nothing below works otherwise. */
  readonly available: boolean;
  /** Where the arbiter lives, for a UI that has to say so. */
  readonly locator: { readonly chain: string; readonly address: string } | null;
  /**
   * Why it is off, when it is off.
   *
   * An arbiter that is switched off is a fact a reader can weigh; an arbiter
   * that is switched off *for an unstated reason* sends its operator to check
   * the two variables the copy happens to name, which is where this went wrong
   * in practice - both were set, and something else entirely had failed. The
   * absence is honest only if it says what it is an absence of.
   */
  readonly unavailableReason?: string;

  /**
   * The bounds the contract was deployed with.
   *
   * Read from the chain rather than mirrored in Bench's config: a form that
   * offers a bond the contract would refuse wastes a user's transaction to be
   * told no, and two copies of a number that must agree is how they stop
   * agreeing.
   */
  limits(): Promise<DisputeLimits>;
  /** Pin a hire's terms. Called when the hire is created, not when it fails. */
  registerHire(registration: HireRegistration): Promise<{ readonly termsHash: string }>;
  /**
   * What the arbiter holds for this hire, or null.
   *
   * Free, and the question a hire page has to answer before it offers anyone a
   * dispute form: terms that were never pinned cannot be ruled on, and finding
   * that out through a refused payable transaction is the wrong moment.
   */
  registration(hireId: string): Promise<PinnedHire | null>;
  /**
   * File a dispute. `null` means submitted but not yet visible on chain.
   *
   * Not a failure: consensus takes a minute or two and a web request cannot
   * wait for it, so the caller reads the dispute back rather than trusting what
   * this returned.
   */
  openDispute(filing: DisputeFiling): Promise<DisputeRecord | null>;
  /** The respondent's filing. Adjudication refuses until its window closes. */
  answer(disputeId: number, evidenceUrls: readonly string[]): Promise<DisputeRecord>;
  /** Rule. Permissionless, and the only call that costs anything. */
  adjudicate(disputeId: number, terms: DisputeTerms): Promise<DisputeRecord | null>;
  get(disputeId: number): Promise<DisputeRecord | null>;
  forHire(hireId: string): Promise<readonly number[]>;
  /** Free, and the number a reader should see beside any ruling. */
  independence(disputeId: number): Promise<EvidenceIndependence>;
}
