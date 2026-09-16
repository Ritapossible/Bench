import type { DisputeRecord, EvidenceIndependence, PinnedHire } from '@bench/core';
import { RaiseDispute } from '@/components/RaiseDispute';
import { adjudicateDispute, pinHireTerms } from '@/lib/dispute/actions';

/**
 * What happens when a hire does not deliver, and who decides.
 *
 * Two states, and the panel must not blur them. Either a deployment has an
 * arbiter - a GenLayer Intelligent Contract, ruled on by validators none of the
 * parties control - or it does not, and then disputes are not adjudicated here
 * at all. The second state is rendered as plainly as the first, because the
 * alternative is a marketplace implying that complaints about its own listings
 * go somewhere independent when they go nowhere.
 */

const STATE_COPY: Record<
  DisputeRecord['state'],
  { readonly badge: string; readonly tone: string; readonly line: string }
> = {
  open: {
    badge: 'Open',
    tone: 'badge-plain',
    line: 'Filed. Nothing has been ruled and no money has moved.',
  },
  upheld: {
    badge: 'Upheld',
    tone: 'badge-blocked',
    line: 'The arbiter found for the hirer. The escrow refunds and the filing bond returns.',
  },
  dismissed: {
    badge: 'Dismissed',
    tone: 'badge-live',
    line: 'The arbiter found the agent did what it was hired to do. The filing bond goes to the agent.',
  },
  abstained: {
    badge: 'Abstained',
    tone: 'badge-thin',
    line: 'The arbiter could not decide on the evidence it was given. This is not a finding for either side: the escrow settles as it would have without a dispute, and the filing bond returns to the hirer.',
  },
};

const GROUND_COPY: Record<DisputeRecord['ground'], string> = {
  breach:
    'Breach - replayed against the mandate this hire was signed under. No model runs; the ruling is arithmetic anyone can recompute.',
  delivery:
    'Delivery - judged by one model call over evidence both sides pinned, with a confidence floor under any finding against the agent.',
};

function Independence({ tally }: { readonly tally: EvidenceIndependence }) {
  const total =
    tally.independent + tally.claimant + tally.respondent + tally.marketplace + tally.unclassified;
  if (total === 0) return null;
  const rows: readonly (readonly [string, number, string])[] = [
    ['Independent', tally.independent, 'Neither party, and not Bench.'],
    ['Hirer', tally.claimant, 'Chosen by the side that complained.'],
    ['Agent', tally.respondent, 'Chosen by the side answering.'],
    ['Bench', tally.marketplace, 'Ours. We list this agent and take a cut of the hire.'],
    ['Unclassified', tally.unclassified, 'Not an https URL this could attribute.'],
  ];

  return (
    <div className="stack stack-8">
      <h3 className="h4">What the ruling was read from</h3>
      <div className="row" style={{ gap: '0.4rem', flexWrap: 'wrap' }}>
        {rows
          .filter(([, n]) => n > 0)
          .map(([label, n, why]) => (
            <span key={label} className="badge badge-plain" title={why}>
              {label} {n}
            </span>
          ))}
      </div>
      <p className="tiny">
        {tally.independent > 0
          ? 'At least one source belongs to neither party and to neither of us.'
          : 'No independent source. Every document behind this ruling was chosen by someone with an interest in the outcome - including us. Weigh it accordingly.'}
      </p>
    </div>
  );
}

/** What just happened, when the filing form redirected back here. */
const OUTCOME: Record<string, { readonly tone: string; readonly text: string }> = {
  filed: {
    tone: 'badge-live',
    /*
      Says what is happening rather than implying it is done. The transaction is
      submitted; GenLayer is reaching consensus, which takes a minute or two,
      and the dispute appears below once it has. Claiming completion here would
      be claiming something this page cannot see yet.
    */
    text: 'Filed. GenLayer validators are reaching consensus on it now, which takes a minute or two - refresh and it will appear below. The agent then has its answer window, and nobody can rule until that closes.',
  },
  ruled: {
    tone: 'badge-live',
    text: 'Sent to the arbiter. Validators are each fetching the evidence and reaching a ruling of their own; refresh in a minute or two to see what they agreed.',
  },
  refused: {
    tone: 'badge-blocked',
    text: 'The arbiter refused that filing. The usual causes are a bond below the minimum, or a hire that was never registered with it.',
  },
  malformed: {
    tone: 'badge-blocked',
    text: 'That filing was incomplete. A dispute needs what you hired the agent to do, and at least one statement about what should have happened.',
  },
  unavailable: {
    tone: 'badge-plain',
    text: 'Disputes are not adjudicated on this deployment, so there was nowhere to file it.',
  },
  pinned: {
    tone: 'badge-live',
    text: 'Terms pinned. The arbiter now holds the rules this hire was made under, and a dispute can be ruled against them.',
  },
  'pin-failed': {
    tone: 'badge-blocked',
    text: 'The terms did not reach the arbiter. Usually a GenLayer key with no balance, or the chain not answering - the hire itself is unaffected, and this can be retried.',
  },
  'not-ruled': {
    tone: 'badge-blocked',
    text: 'The arbiter would not rule yet. Either the answer window is still open, or this dispute has already settled.',
  },
};

export function DisputePanel({
  available,
  locator,
  unavailableReason,
  disputes,
  hireId,
  pinned,
  minBondGen,
  answerHours,
  outcome,
}: {
  readonly available: boolean;
  readonly locator: { readonly chain: string; readonly address: string } | null;
  /** Why it is off, when it is off. Shown verbatim - see the panel below. */
  readonly unavailableReason?: string | undefined;
  readonly disputes: readonly DisputeRecord[];
  /**
   * Not gated on whether the hire is still live, deliberately.
   *
   * A dispute is about work that already happened, and a revoked or settled
   * hire is exactly when someone wants to raise one. An earlier draft hid the
   * form once authority ended, which withdrew the remedy at the moment it
   * became useful.
   */
  readonly hireId: string;
  readonly minBondGen: number;
  readonly answerHours: number;
  /**
   * What the arbiter holds for this hire, or null when it holds nothing.
   *
   * The filing form is offered only over a pinned hire. `open_dispute` refuses
   * an unregistered one outright, and discovering that through a payable
   * transaction - at the moment a hirer is angriest - is the wrong way to find
   * out.
   */
  readonly pinned: PinnedHire | null;
  /** The `?dispute=` code the filing form redirected with, if any. */
  readonly outcome: string | null;
}) {
  const said = outcome === null ? null : (OUTCOME[outcome] ?? null);
  if (!available) {
    return (
      <div className="card stack stack-12">
        <div className="row-between">
          <h2 className="h3">Disputes</h2>
          <span className="badge badge-plain">Not on this deployment</span>
        </div>
        <p className="body">
          The escrow can be marked disputed, and nothing on this deployment rules on it. Past the
          window, ERC-8183 releases to the agent regardless.
        </p>
        <p className="small">
          The adjudicator is a GenLayer Intelligent Contract -{' '}
          <span className="mono">contracts/genlayer/arbiter.py</span> in the repository - and it is
          switched off here rather than replaced with something local. Bench lists this agent, ranks
          it, and takes a cut of this hire; a ruling computed by us would be a marketplace deciding
          a complaint about its own listing.
        </p>
        {/*
          The actual reason, not a guess at it.

          This used to end with "set GENLAYER_RPC_URL and GENLAYER_ARBITER_ADDRESS"
          whatever had gone wrong. When both were already set - and the real
          cause was an unrelated variable failing config validation, which takes
          the whole arbiter down with it - that sentence sent its reader to look
          in exactly the wrong place, and kept them there.
        */}
        {unavailableReason === undefined ? null : (
          <p className="tiny break" style={{ opacity: 0.8 }}>
            <strong className="ink">Why: </strong>
            <span className="mono">{unavailableReason}</span>
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="card stack stack-16">
      <div className="row-between">
        <h2 className="h3">Disputes</h2>
        {locator === null ? null : (
          <span className="badge badge-live mono" style={{ fontSize: '0.7rem' }}>
            {locator.chain}
          </span>
        )}
      </div>

      {said === null ? null : (
        <div className="row" style={{ gap: '0.5rem', alignItems: 'flex-start' }}>
          <span className={`badge ${said.tone}`}>Filing</span>
          <p className="small ink" role="status">
            {said.text}
          </p>
        </div>
      )}

      <p className="body">
        Ruled on by an Intelligent Contract on GenLayer, where each validator fetches the evidence
        and runs the judgment itself. Not by us: we list this agent and take a cut of this hire.
      </p>
      {locator === null ? null : (
        <p className="tiny mono break" style={{ opacity: 0.6 }}>
          {locator.address}
        </p>
      )}

      <Pinned hireId={hireId} pinned={pinned} />

      {disputes.length === 0 ? (
        <div className="stack stack-12">
          <p className="small">
            No dispute has been raised on this hire. Raising one costs a filing bond, which returns
            unless the arbiter positively finds the agent delivered.
          </p>
          {pinned === null ? null : (
            <RaiseDispute hireId={hireId} minBondGen={minBondGen} answerHours={answerHours} />
          )}
        </div>
      ) : (
        <div className="stack stack-16">
          {disputes.map((d) => {
            const copy = STATE_COPY[d.state];
            const tally = d.verdict?.evidence ?? countOrigins(d);
            return (
              <div key={d.disputeId} className="stack stack-8">
                <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
                  <span className={`badge ${copy.tone}`}>{copy.badge}</span>
                  <span className="mono tiny">#{d.disputeId}</span>
                  {d.verdict === null ? null : (
                    <span className="badge badge-plain tiny">
                      {d.verdict.resolvedBy === 'replay' ? 'no model used' : 'one model call'}
                    </span>
                  )}
                  {d.extensions > 0 ? (
                    <span className="badge badge-thin tiny">
                      extended {d.extensions}
                      {d.extensions === 1 ? ' time' : ' times'}
                    </span>
                  ) : null}
                </div>

                <p className="small ink">{copy.line}</p>
                <p className="tiny">{GROUND_COPY[d.ground]}</p>
                <FiledBy claimant={d.claimant} onBehalfOf={d.onBehalfOf} />

                {d.criteria.length === 0 ? null : (
                  <ol className="stack stack-4" style={{ paddingLeft: '1.1rem' }}>
                    {d.criteria.map((c, i) => {
                      const reading = d.verdict?.criteria.find((r) => r.id === i + 1);
                      return (
                        <li key={c} className="small">
                          {c}
                          {reading === undefined ? null : (
                            <span className="tiny" style={{ marginLeft: '0.4rem', opacity: 0.7 }}>
                              - {reading.status}
                              {reading.status === 'unresolved'
                                ? ''
                                : ` (${reading.confidence}% confident)`}
                            </span>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                )}

                <Independence tally={tally} />

                {d.state === 'open' ? (
                  <div className="stack stack-8">
                    <p className="tiny">
                      {Date.now() < d.answerEndsAt.getTime()
                        ? `The agent has until ${d.answerEndsAt.toISOString()} to file its own evidence. Nobody can rule before then - a verdict taken on one side's documents is one side's verdict.`
                        : `Open for adjudication. Anyone may call it, and the window closes ${d.windowEndsAt.toISOString()}.`}
                    </p>
                    {Date.now() < d.answerEndsAt.getTime() ? null : (
                      <form action={adjudicateDispute}>
                        <input type="hidden" name="hireId" value={hireId} />
                        <input type="hidden" name="disputeId" value={d.disputeId} />
                        <button type="submit" className="btn btn-primary btn-sm">
                          Ask the arbiter to rule
                        </button>
                        <p className="tiny" style={{ marginTop: '0.5rem' }}>
                          Anyone may press this, and it is the only call in the dispute that costs
                          anything. Restricting it to you would let the agent pay privately for the
                          window to lapse. Consensus takes minutes: validators fetch the evidence
                          and each reach a ruling of their own before the answers are compared.
                        </p>
                      </form>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Whether the arbiter holds the rules this hire was made under.
 *
 * The most easily skipped state in the whole layer and the one that decides
 * whether any of it works. Terms are pinned at hire time, before anyone knows
 * there will be a dispute - that is what makes them a fact about the past
 * rather than a position in the present - and a hire whose terms never reached
 * the chain cannot be disputed at all. Said here, plainly, rather than
 * discovered through a refused payable transaction later.
 */
function Pinned({
  hireId,
  pinned,
}: {
  readonly hireId: string;
  readonly pinned: PinnedHire | null;
}) {
  if (pinned === null) {
    return (
      <div className="stack stack-8">
        <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
          <span className="badge badge-thin">Terms not pinned</span>
        </div>
        <p className="small">
          The arbiter does not hold the rules this hire was made under, so it cannot rule on it.
          Terms are normally pinned the moment a hire is created; this one did not reach the chain.
        </p>
        <form action={pinHireTerms}>
          <input type="hidden" name="hireId" value={hireId} />
          <button type="submit" className="btn btn-outline btn-sm">
            Pin the terms now
          </button>
        </form>
        <p className="tiny">
          The terms are computed from the stored hire, not from this form - the same function the
          ruling hashes them with. This is a retry, not a second chance to choose them.
        </p>
      </div>
    );
  }

  return (
    <div className="stack stack-8">
      <div className="row" style={{ gap: '0.5rem', alignItems: 'center' }}>
        <span className="badge badge-live">Terms pinned</span>
        <span className="tiny">{pinned.registeredAt.toISOString()}</span>
      </div>
      <p className="tiny">
        The mandate, envelope and policy this hire ran under are fixed on the arbiter by digest, so
        neither side can restate them now. The action record is published at{' '}
        <span className="mono break">{pinned.recordUrl}</span> - pinned at the same moment, which is
        why a claimant cannot pick a flattering source afterwards.
      </p>
      <p className="tiny mono break" style={{ opacity: 0.6 }}>
        sha256 {pinned.termsHash}
      </p>
    </div>
  );
}

/**
 * Who actually filed, when it was not the hirer.
 *
 * The contract lets the address that registered a hire file on behalf of the
 * client it registered, because otherwise nobody can: the client on a
 * marketplace hire is whatever identity the marketplace holds for its user, and
 * on this deployment that is a per-browser id with no private key anywhere. The
 * widening is real, so it is shown rather than implied - a reader should never
 * have to guess whether the hirer raised this or we did.
 *
 * Silent when the two match, which is what a wallet-connected hirer filing for
 * themselves looks like.
 */
function FiledBy({
  claimant,
  onBehalfOf,
}: {
  readonly claimant: string;
  readonly onBehalfOf: string;
}) {
  if (claimant.toLowerCase() === onBehalfOf.toLowerCase()) return null;
  return (
    <p className="tiny">
      Filed by Bench on the hirer&rsquo;s behalf, and the chain records both addresses. We posted
      the bond, so a frivolous filing costs us rather than you - and we still do not decide it. The
      ruling is the validators&rsquo;.
    </p>
  );
}

/** Before a ruling exists, the tally comes from the sources themselves. */
function countOrigins(d: DisputeRecord): EvidenceIndependence {
  const tally = {
    independent: 0,
    claimant: 0,
    respondent: 0,
    marketplace: 0,
    unclassified: 0,
  };
  for (const s of d.sources) tally[s.origin] += 1;
  return tally;
}
