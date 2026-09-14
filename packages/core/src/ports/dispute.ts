import type { AgentId } from '../types/agent.js';
import type { Address } from '../types/primitives.js';
import type {
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
  readonly claimant: Address;
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

export interface DisputeResolver {
  /** True when an arbiter is actually configured. Nothing below works otherwise. */
  readonly available: boolean;
  /** Where the arbiter lives, for a UI that has to say so. */
  readonly locator: { readonly chain: string; readonly address: string } | null;

  /** Pin a hire's terms. Called when the hire is created, not when it fails. */
  registerHire(registration: HireRegistration): Promise<{ readonly termsHash: string }>;
  openDispute(filing: DisputeFiling): Promise<DisputeRecord>;
  /** The respondent's filing. Adjudication refuses until its window closes. */
  answer(disputeId: number, evidenceUrls: readonly string[]): Promise<DisputeRecord>;
  /** Rule. Permissionless, and the only call that costs anything. */
  adjudicate(disputeId: number, terms: DisputeTerms): Promise<DisputeRecord>;
  get(disputeId: number): Promise<DisputeRecord | null>;
  forHire(hireId: string): Promise<readonly number[]>;
  /** Free, and the number a reader should see beside any ruling. */
  independence(disputeId: number): Promise<EvidenceIndependence>;
}
