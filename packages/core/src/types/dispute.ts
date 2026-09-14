import { checkMandate, EMPTY_MANDATE_STATE, applySpend } from './mandate.js';
import { checkAgainstEnvelope, DEFAULT_ENVELOPE_POLICY, isEnvelopeThin } from './envelope.js';
import type { HireMandate, MandateRule } from './mandate.js';
import type { BehaviouralEnvelope, EnvelopePolicy, EnvelopeRule } from './envelope.js';
import type { InterceptedAction } from './audition.js';
import type { Address } from './primitives.js';

/**
 * ============================================================================
 * Disputes: what happens when a hire does not deliver.
 * ============================================================================
 *
 * `EscrowStatus` has carried a `disputed` member since the first week, and
 * `EscrowClient.dispute(jobId, reason)` has been callable the whole time. What
 * neither has is an adjudicator. A disputed job sits disputed; the window
 * closes; ERC-8183's optimistic rule releases to the agent anyway. The status
 * was a label on a hole.
 *
 * The hole is not an oversight, it is the hard part. Deciding whether an agent
 * delivered is a judgment, and judgment is exactly what a conventional chain
 * cannot perform and what neither party can be trusted to perform, because the
 * parties who care are precisely the parties who must not decide. Bench cannot
 * decide it either: Bench lists the agent, ranks it, and takes a cut. A
 * marketplace adjudicating disputes about its own listings is marking its own
 * homework, and saying so is cheaper than being caught at it.
 *
 * So the ruling goes to a GenLayer Intelligent Contract - see
 * `contracts/genlayer/arbiter.py` - and this module is the half of it that is
 * pure, deterministic, and shared by both sides so they cannot drift.
 *
 * **Two grounds, two costs.**
 *
 * | | `breach` | `delivery` |
 * |---|---|---|
 * | The claim | "it did something it was not allowed to do" | "it did not do the job" |
 * | How it settles | replay the gate over the recorded actions | one model call over pinned evidence |
 * | Cost | zero model calls | one model call |
 * | Guarantee | arithmetic over a signed mandate - nothing to argue with | a judgment with a confidence attached |
 * | Fails when | the action record is incomplete | evidence is ambiguous or silent |
 *
 * Prefer `breach` wherever the complaint can be phrased as a rule the mandate
 * already carries. It is deterministic, free, and unarguable, and a reviewer
 * can recompute it from the stored mandate and the stored actions with no
 * network and no model.
 */

/** Which question the arbiter is being asked. */
export type DisputeGround = 'breach' | 'delivery';

/** What the arbiter concluded about one criterion. */
export type CriterionStatus = 'met' | 'unmet' | 'unresolved';

/**
 * The outcome of a ruling.
 *
 * `upheld` means the claimant was right and the escrow should refund.
 * `dismissed` means the agent did what it was hired to do.
 * `unresolved` is neither, and is not a failure - it is the arbiter declining
 * to rule on evidence that does not support one, which extends the window.
 */
export type DisputeRuling = 'upheld' | 'dismissed' | 'unresolved';

/**
 * The state a dispute record is in.
 *
 * `abstained` is the terminal form of repeated `unresolved`: the arbiter ran
 * out of extensions without reaching a ruling. It is deliberately not a
 * synonym for `dismissed`. The escrow's own optimistic default then applies -
 * money moves as it would have without a dispute - but the record says the
 * arbiter could not decide rather than that the agent was cleared, and both
 * parties' histories carry that distinction.
 */
export type DisputeState = 'open' | 'upheld' | 'dismissed' | 'abstained';

/**
 * Where a piece of evidence comes from, relative to the people arguing.
 *
 * The most important field in this module, and the one that belongs in front
 * of a user. A dispute settled entirely on the respondent's own status page is
 * weak by construction; so is one settled entirely on the claimant's. And a
 * dispute settled entirely on *Bench's* API is the weakest of the three,
 * because Bench is not a bystander - it lists the agent, ranks it, and profits
 * from the hire. `marketplace` exists as its own category rather than being
 * folded into `independent` for exactly that reason.
 */
export type EvidenceOrigin =
  | 'independent'
  | 'claimant'
  | 'respondent'
  | 'marketplace'
  | 'unclassified';

export interface EvidenceSource {
  readonly url: string;
  readonly origin: EvidenceOrigin;
}

export interface EvidenceIndependence {
  readonly independent: number;
  readonly claimant: number;
  readonly respondent: number;
  readonly marketplace: number;
  readonly unclassified: number;
}

/** The domains that make a source interested rather than independent. */
export interface DisputeParties {
  /** Whoever raised the dispute. Usually the hirer; may be another agent. */
  readonly claimantDomain?: string;
  /** Whoever is answering it. Usually the hired agent's operator. */
  readonly respondentDomain?: string;
  /** Bench's own host. Never independent, however convenient its data is. */
  readonly marketplaceDomain?: string;
}

const hostOf = (url: string): string | null => {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** `a.example` is covered by `example`; `notexample.com` is not by `example.com`. */
const covers = (domain: string, host: string): boolean => {
  const d = domain.trim().toLowerCase().replace(/^\.+/, '');
  if (d === '') return false;
  return host === d || host.endsWith(`.${d}`);
};

/**
 * Classify one evidence URL against the parties.
 *
 * A host comparison, not an opinion - which is what makes the independence
 * tally worth showing: it requires no trust in anyone's judgment and anyone can
 * recompute it from the URLs alone.
 *
 * Order matters where a domain could match twice. The marketplace is checked
 * first, because Bench hosting a party's page does not make that page
 * independent of Bench.
 */
export function classifyEvidence(url: string, parties: DisputeParties): EvidenceOrigin {
  const host = hostOf(url);
  if (host === null) return 'unclassified';
  if (parties.marketplaceDomain !== undefined && covers(parties.marketplaceDomain, host)) {
    return 'marketplace';
  }
  if (parties.claimantDomain !== undefined && covers(parties.claimantDomain, host)) {
    return 'claimant';
  }
  if (parties.respondentDomain !== undefined && covers(parties.respondentDomain, host)) {
    return 'respondent';
  }
  return 'independent';
}

export function evidenceIndependence(sources: readonly EvidenceSource[]): EvidenceIndependence {
  const tally: EvidenceIndependence = {
    independent: 0,
    claimant: 0,
    respondent: 0,
    marketplace: 0,
    unclassified: 0,
  };
  const counts = { ...tally };
  for (const s of sources) counts[s.origin] += 1;
  return counts;
}

/**
 * Whether the evidence behind a dispute is worth anything on its own.
 *
 * Not a gate - the arbiter rules either way and says what it ruled on. This is
 * for the reader: a ruling with no independent source is a ruling made
 * entirely on material the interested parties chose, and a UI that renders it
 * identically to one backed by a registry is misleading by omission.
 */
export const hasIndependentEvidence = (tally: EvidenceIndependence): boolean =>
  tally.independent > 0;

/**
 * The key a hire is registered under on the arbiter, mirroring `hire_key` in
 * `contracts/genlayer/lib/arbiter_core.py`.
 *
 * **Bench's own hire id cannot be the key.** Registration is open to anyone -
 * it has to be, because the party holding both halves of a hire at the moment
 * it is created is the marketplace, which is neither the client nor the
 * respondent. Keyed on the bare id, whoever learned an id first could register
 * it, name themselves client, and leave the real client permanently unable to
 * open a dispute. Bench's ids are opaque, so that needs a guess - and resting
 * access control on an id being hard to guess is exactly the weak guarantee
 * this codebase does not build on.
 *
 * Prefixing with the registrant's own address removes the race: two registrars
 * cannot collide, and the key says who registered it.
 *
 * Lower-cased on both sides, because an address that differs only in checksum
 * casing is the same account and must not produce a second, unreachable hire.
 */
export const hireKey = (registrar: string, hireId: string): string =>
  `${registrar.toLowerCase()}/${hireId}`;

/** Who registered a hire, read straight back off its key. */
export const registrarOf = (key: string): string =>
  key.includes('/') ? (key.split('/', 1)[0] ?? '') : '';

/** The bare Bench hire id inside a key, or the input when it carries no prefix. */
export const hireIdOf = (key: string): string => {
  const cut = key.indexOf('/');
  return cut === -1 ? key : key.slice(cut + 1);
};

/**
 * One admitted action, in the shape the arbiter replays.
 *
 * Seconds and decimal strings rather than `Date` and `bigint`, because this is
 * what gets published: the validators parse it with `json.loads` and the
 * digest they compare is taken over the parsed value. A field that serialises
 * differently in two places is a record that disagrees with itself.
 *
 * **Only actions the gate admitted are recorded.** A proposal the gate refused
 * was never signed and never happened; putting it in the record would
 * manufacture a breach out of Bench's own safety rail doing its job. The trace
 * keeps the refusals, and the trace is not the record.
 */
export interface RecordedAction {
  readonly seq: number;
  /** Unix seconds. Each action is judged by the clock when it happened. */
  readonly at: number;
  readonly to: string | null;
  /** Base units, decimal, as a string. */
  readonly value: string;
  readonly data: string;
  readonly token: string;
}

/**
 * The published action record: what the arbiter fetches and replays.
 *
 * `revoked_at` rides in the record rather than in the pinned terms, and that is
 * the only place it can live. Terms are digest-pinned at hire time, before
 * anyone knows there will be a dispute - and revocation happens later, so a
 * `revoked_at` inside them would be either absent for ever or a value that
 * changes after the digest was taken. Spending past the kill switch is the
 * breach a hirer is angriest about, and pinning it into the terms would make it
 * unprovable.
 *
 * It is evidence, not testimony: the record's likeliest publisher is Bench,
 * which the arbiter classifies as `marketplace`, and every published copy has
 * to agree or the dispute goes unresolved.
 */
export interface ActionRecord {
  readonly hire_id: string;
  readonly actions: readonly RecordedAction[];
  /** Unix seconds, or null while the mandate is still live. */
  readonly revoked_at: number | null;
}

/** Seconds, floored. The contract compares integers and has no milliseconds. */
export const atSeconds = (at: Date): number => Math.floor(at.getTime() / 1000);

/**
 * An action as the dispute sees it.
 *
 * `InterceptedAction` plus the token the value moved in, because the action
 * record cannot supply it. The interceptor records `to`, `value` and `data`;
 * `value` is always the native token, and an ERC-20 transfer is a zero-value
 * call whose amount is inside `data`. So the replay below can check native
 * spend against a native cap exactly, and cannot see an ERC-20 amount at all.
 *
 * Stated here rather than discovered later: a mandate denominated in a token
 * whose transfers this cannot decode is bounded by its allowlist and its action
 * limit, not by its spend caps. That is a real limit of the deterministic
 * ground, and a dispute about such a spend belongs on the `delivery` ground
 * where a model can read a block explorer.
 */
export interface DisputedAction extends InterceptedAction {
  /** The token `value` is denominated in. Defaults to the mandate's own. */
  readonly token?: Address;
}

/** One rule the replay found broken, and where. */
export interface BreachFinding {
  readonly rule: MandateRule | EnvelopeRule;
  /** The action's sequence number in the hire's record. */
  readonly seq: number;
  readonly explanation: string;
}

export interface BreachAudit {
  readonly findings: readonly BreachFinding[];
  /**
   * True when the envelope was too thin to enforce.
   *
   * The envelope rules are still reported, and still must not settle a dispute
   * on their own: an envelope built from fewer than `MIN_ENVELOPE_SAMPLE`
   * auditions describes one run's habits rather than an agent's behaviour, and
   * slashing on it would punish an agent for doing something slightly
   * different the first time. Mandate rules are unaffected - the owner signed
   * those.
   */
  readonly envelopeAdvisory: boolean;
  /** Actions the replay could read. Fewer than supplied means a gap in the record. */
  readonly actionsConsidered: number;
}

/**
 * Replay the hire's recorded actions against the terms it was hired under.
 *
 * **This is the gate, run backwards.** `checkMandate` and
 * `checkAgainstEnvelope` decide whether a transaction may be signed; the same
 * two functions, over the sequence that actually happened, decide whether one
 * should have been. Reusing them is the whole point: a dispute that applied its
 * own rulebook could find a breach the gate would have allowed, or clear one it
 * would have refused, and then two parts of Bench would disagree about what the
 * agent was permitted to do. There is exactly one definition and this is a
 * second reading of it.
 *
 * **Why a breach is possible at all, given a gate.** Three ways, all real:
 * the envelope is advisory below `MIN_ENVELOPE_SAMPLE` and the gate lets those
 * through by design; the mandate's on-chain caps bind the session key while the
 * envelope binds only what passes through Bench; and an agent holding a session
 * key can submit directly to the chain without asking Bench anything. The
 * replay is what notices afterwards.
 *
 * Pure and total, so a reviewer can recompute any ruling on the deterministic
 * ground from the stored mandate and the stored actions, with no network, no
 * model, and no trust in whoever ran it first.
 */
export function replayAgainstTerms(
  actions: readonly DisputedAction[],
  mandate: HireMandate,
  envelope: BehaviouralEnvelope,
  policy: EnvelopePolicy = DEFAULT_ENVELOPE_POLICY,
  /**
   * When the owner pulled the kill switch, if they did.
   *
   * Passed in rather than read off a state object because the replay walks
   * time: an action before this moment was authorised and one after it was
   * not, and a single boolean would have to pick one answer for the whole
   * hire. An agent that kept spending after a revocation is the breach this
   * argument exists to catch, and it is the one a hirer is angriest about.
   */
  revokedAt: Date | null = null,
): BreachAudit {
  const findings: BreachFinding[] = [];
  const ordered = [...actions].sort((a, b) => a.seq - b.seq);

  let mandateState = EMPTY_MANDATE_STATE;
  let cumulativeValueWei = 0n;
  let priorActionCount = 0;

  for (const action of ordered) {
    // The action's own timestamp, not "now". A mandate that has since expired
    // did not expire retroactively over transactions sent while it was live,
    // and judging them against the clock at adjudication would find a breach
    // in every hire that ever ran to completion.
    const at = action.at;
    const token = action.token ?? mandate.bounds.totalSpendCap.token;

    const revokedByNow =
      revokedAt !== null && at.getTime() >= revokedAt.getTime() ? revokedAt : null;
    const mandateDecision = checkMandate(
      { to: action.to, value: action.value, token },
      mandate,
      { ...mandateState, revokedAt: revokedByNow },
      at,
    );
    for (const rule of mandateDecision.rules) {
      findings.push({ rule, seq: action.seq, explanation: mandateDecision.explanation });
    }

    const envelopeDecision = checkAgainstEnvelope(
      {
        to: action.to,
        value: action.value,
        data: action.data,
        cumulativeValueWei,
        priorActionCount,
      },
      envelope,
      policy,
    );
    for (const rule of envelopeDecision.rules) {
      findings.push({ rule, seq: action.seq, explanation: envelopeDecision.explanation });
    }

    // State advances whether or not the action broke a rule: it happened. A
    // replay that skipped spend on a refused action would under-count the
    // total and clear a hire that blew its cap on its second transaction.
    mandateState = applySpend(mandateState, action.value);
    cumulativeValueWei += action.value;
    priorActionCount += 1;
  }

  return {
    findings,
    envelopeAdvisory: isEnvelopeThin(envelope),
    actionsConsidered: ordered.length,
  };
}

/**
 * Which findings can settle a dispute on their own.
 *
 * Mandate rules can: the owner signed those bounds and the agent accepted them.
 * Envelope rules cannot while the envelope is advisory, for the reason given on
 * `BreachAudit.envelopeAdvisory` - they are reported, they are not grounds.
 */
export function bindingFindings(audit: BreachAudit): readonly BreachFinding[] {
  if (!audit.envelopeAdvisory) return audit.findings;
  const mandateRules = new Set<string>([
    'revoked',
    'expired',
    'per-tx-cap-exceeded',
    'total-cap-exceeded',
    'contract-not-allowlisted',
    'action-limit-reached',
    'wrong-token',
  ]);
  return audit.findings.filter((f) => mandateRules.has(f.rule));
}

export interface CriterionReading {
  readonly id: number;
  readonly status: CriterionStatus;
  /** 0-100. Below the arbiter's threshold, `unmet` is read as `unresolved`. */
  readonly confidence: number;
}

/**
 * Turn per-criterion readings into a ruling, by fixed rule.
 *
 * The model reads; this rules. Separating them is what makes prompt injection
 * pointless: the prompt is never told a dispute exists, never told money moves,
 * and never given the word "upheld" to aim at. Text inside a fetched page has
 * no lever to pull because no lever appears in the prompt.
 *
 * Any `unmet` upholds the dispute - the claimant only has to be right about one
 * thing. All `met` dismisses it. Anything else is `unresolved`, which is the
 * direction ambiguity must fall: an unresolved dispute extends and costs
 * nobody anything, while a wrong ruling in either direction moves money that
 * does not come back.
 */
export function deriveDisputeRuling(readings: readonly CriterionReading[]): DisputeRuling {
  if (readings.length === 0) return 'unresolved';
  if (readings.some((r) => r.status === 'unmet')) return 'upheld';
  if (readings.every((r) => r.status === 'met')) return 'dismissed';
  return 'unresolved';
}

/**
 * Confidence below which an `unmet` reading is downgraded to `unresolved`.
 *
 * Applied to `unmet` only, and the asymmetry is the point: upholding a dispute
 * takes money from a party that may have delivered, so it needs conviction.
 * Dismissing one leaves the escrow to settle exactly as it would have without
 * the dispute, which is the outcome the parties already agreed to.
 */
export const MIN_UPHOLD_CONFIDENCE = 75;

export function applyConfidenceFloor(
  readings: readonly CriterionReading[],
  floor: number = MIN_UPHOLD_CONFIDENCE,
): readonly CriterionReading[] {
  return readings.map((r) =>
    r.status === 'unmet' && r.confidence < floor ? { ...r, status: 'unresolved' as const } : r,
  );
}

/** The full record of one ruling, as the arbiter returns it. */
export interface DisputeVerdict {
  readonly ruling: DisputeRuling;
  readonly ground: DisputeGround;
  readonly criteria: readonly CriterionReading[];
  /** `replay` for the deterministic ground, `model` for the judged one. */
  readonly resolvedBy: 'replay' | 'model';
  readonly evidence: EvidenceIndependence;
  /** Findings, when the ground was `breach`. Empty otherwise. */
  readonly findings: readonly BreachFinding[];
  readonly ruledAt: Date;
}
