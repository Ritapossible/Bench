import { BenchError } from '@bench/core';
import type {
  DisputeFiling,
  DisputeLimits,
  DisputeRecord,
  DisputeResolver,
  DisputeTerms,
  EvidenceIndependence,
  HireRegistration,
  PinnedHire,
} from '@bench/core';

/**
 * The dispute layer, switched off.
 *
 * **Every method refuses, and that is the feature.** The obvious thing to build
 * here is an in-memory arbiter that returns a plausible verdict so the UI has
 * something to render and the demo never blocks. It would also be Bench ruling
 * on disputes about agents Bench lists, ranks and takes a cut of - the precise
 * conflict of interest the whole layer exists to remove - and it would look
 * identical to the real thing from the outside.
 *
 * Every other adapter in this codebase has a fake behind it and should. This
 * one must not, because the property being faked is not "a ruling happens", it
 * is "the ruling does not come from us". A stub cannot fake that; it can only
 * contradict it while appearing to satisfy it.
 *
 * So a deployment without an arbiter says so. `available` is false, the status
 * page reports the queue as switched off rather than broken, and the hire page
 * tells a user that disputes are not adjudicated on this deployment. That is a
 * limitation a reader can see and weigh. The alternative is one they cannot.
 */
export class UnconfiguredArbiter implements DisputeResolver {
  readonly available = false;
  readonly locator = null;

  readonly unavailableReason: string;

  constructor(private readonly why: string = 'no GenLayer arbiter is configured') {
    this.unavailableReason = why;
  }

  #refuse(): never {
    throw new BenchError(
      'INVALID_REQUEST',
      `disputes are not adjudicated on this deployment: ${this.why}. ` +
        'Set GENLAYER_RPC_URL and GENLAYER_ARBITER_ADDRESS to enable them.',
    );
  }

  /**
   * Bounds, even here. The panel renders the "switched off" state and never
   * shows the form, but a caller asking what the floor is should get a number
   * rather than an exception - and these are the contract's own defaults.
   */
  async limits(): Promise<DisputeLimits> {
    return {
      minBond: 10_000_000_000_000_000n,
      answerPeriodSec: 86_400,
      claimPeriodSec: 604_800,
      maxSources: 6,
      maxExtensions: 2,
      minConfidence: 75,
    };
  }

  async registerHire(_registration: HireRegistration): Promise<{ readonly termsHash: string }> {
    this.#refuse();
  }

  async openDispute(_filing: DisputeFiling): Promise<DisputeRecord> {
    this.#refuse();
  }

  async answer(_disputeId: number, _evidenceUrls: readonly string[]): Promise<DisputeRecord> {
    this.#refuse();
  }

  async adjudicate(_disputeId: number, _terms: DisputeTerms): Promise<DisputeRecord> {
    this.#refuse();
  }

  /**
   * Reads answer with absence rather than an error.
   *
   * A page asking "does this hire have a dispute?" gets "no", which is true:
   * there is nowhere for one to exist. Refusing a read would turn every hire
   * page on an unconfigured deployment into an error boundary over a question
   * that has a perfectly good answer.
   */
  async get(_disputeId: number): Promise<DisputeRecord | null> {
    return null;
  }

  async registration(_hireId: string): Promise<PinnedHire | null> {
    return null;
  }

  async forHire(_hireId: string): Promise<readonly number[]> {
    return [];
  }

  async independence(_disputeId: number): Promise<EvidenceIndependence> {
    return { independent: 0, claimant: 0, respondent: 0, marketplace: 0, unclassified: 0 };
  }
}
