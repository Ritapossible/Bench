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

/*
  The ground, as a tooltip on the word rather than a paragraph under it.

  How each ground is decided is the same for every dispute on the page, so the
  full version is said once above the list. What has to stay per dispute is
  which of the two this one is - and a reader who does not already know what
  "breach" means here should be able to find out without scrolling.
*/
const GROUND_COPY: Record<DisputeRecord['ground'], string> = {
  breach:
    'Replayed against the mandate this hire was signed under. No model runs; the ruling is arithmetic anyone can recompute.',
  delivery:
    'Judged by one model call over evidence both sides pinned, with a confidence floor under any finding against the agent.',
};

/**
 * Where the evidence came from, in one line of chips.
 *
 * This used to be a heading, five rows and a paragraph under every dispute. The
 * attribution is the point - it is the difference between a ruling read from
 * independent sources and one read from our own logs - but repeating the
 * explanation per dispute buried it. The chips carry the counts; the sentence
 * behind them is said once, above the list.
 */
function Tally({ tally }: { readonly tally: EvidenceIndependence }) {
  const rows: readonly (readonly [string, number, string])[] = [
    ['independent', tally.independent, 'Neither party, and not Bench.'],
    ['hirer', tally.claimant, 'Chosen by the side that complained.'],
    ['agent', tally.respondent, 'Chosen by the side answering.'],
    ['Bench', tally.marketplace, 'Ours. We list this agent and take a cut of the hire.'],
    ['unclassified', tally.unclassified, 'Not an https URL this could attribute.'],
  ];
  const shown = rows.filter(([, n]) => n > 0);
  if (shown.length === 0) return null;

  return (
    <span className="row" style={{ gap: '0.3rem', flexWrap: 'wrap' }}>
      {shown.map(([label, n, why]) => (
        <span key={label} className="badge badge-plain tiny" title={why}>
          {label} {n}
        </span>
      ))}
      {/*
        Kept, compressed. An all-interested evidence set is the one thing a
        reader most needs from this row and the one a marketplace has the most
        reason to leave out, so it stays visible - as a chip rather than the
        paragraph it used to be.
      */}
      {tally.independent === 0 ? (
        <span
          className="badge badge-thin tiny"
          title="Every document behind this ruling was chosen by someone with an interest in the outcome, including us."
        >
          none independent
        </span>
      ) : null}
    </span>
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

      {/*
        Said once, above the list, rather than under every dispute.
        With several disputes on one hire the same three paragraphs repeated
        three times and the page became something to scroll past rather than
        read. The facts did not change per dispute, so they do not belong per
        dispute.
      */}
      {disputes.length === 0 ? null : (
        <details className="stack stack-8">
          <summary className="small ink" style={{ cursor: 'pointer' }}>
            How a dispute here is decided
          </summary>
          <p className="tiny">
            <strong className="ink">Breach</strong> is replayed against the mandate this hire was
            signed under: no model runs, and the ruling is arithmetic anyone can recompute.{' '}
            <strong className="ink">Delivery</strong> is judged by one model call over evidence both
            sides pinned, with a confidence floor under any finding against the agent.
          </p>
          <p className="tiny">
            Bench files on the hirer&rsquo;s behalf and posts the bond, so a frivolous filing costs
            us rather than you, and the chain records both addresses. We still do not decide it: the
            ruling is reached by validators none of the three parties control.
          </p>
          <p className="tiny">
            Terms are pinned when the hire is created, before anyone knows there will be a dispute.
            That is what makes them a fact about the past rather than a position taken in the
            present, and it is why a claimant cannot pick a flattering source afterwards.
          </p>
          <p className="tiny">
            Evidence is attributed rather than pooled. <span className="mono">independent</span>{' '}
            belongs to neither party and not to us; <span className="mono">Bench</span> is our own
            action record, which is the most convenient evidence in any Bench dispute and the least
            disinterested.
          </p>
        </details>
      )}

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
            const waiting = Date.now() < d.answerEndsAt.getTime();
            return (
              <div key={d.disputeId} className="dispute-row">
                <div
                  className="row"
                  style={{ gap: '0.4rem', alignItems: 'center', flexWrap: 'wrap' }}
                >
                  <span className={`badge ${copy.tone}`}>{copy.badge}</span>
                  <span className="mono tiny">#{d.disputeId}</span>
                  <span className="tiny" title={GROUND_COPY[d.ground]}>
                    {d.ground}
                  </span>
                  {d.verdict === null ? null : (
                    <span className="badge badge-plain tiny">
                      {d.verdict.resolvedBy === 'replay' ? 'no model used' : 'one model call'}
                    </span>
                  )}
                  {d.extensions > 0 ? (
                    <span className="badge badge-thin tiny">extended {d.extensions}</span>
                  ) : null}
                  <FiledBy claimant={d.claimant} onBehalfOf={d.onBehalfOf} />
                  <span className="spacer" />
                  <Tally tally={tally} />
                </div>

                {d.criteria.length === 0 ? null : (
                  <ol className="stack stack-4" style={{ paddingLeft: '1.1rem', margin: 0 }}>
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

                {/*
                  One line about what happens next, not a paragraph. The state
                  badge above already says where this dispute is; this says only
                  the thing the badge cannot - when, and what unblocks it.
                */}
                {d.state === 'open' ? null : <p className="tiny">{copy.line}</p>}

                {d.state === 'open' ? (
                  waiting ? (
                    <p className="tiny">
                      Answer window closes{' '}
                      {d.answerEndsAt.toISOString().replace('T', ' ').slice(0, 16)}. Nobody may rule
                      before then.
                    </p>
                  ) : (
                    <form
                      action={adjudicateDispute}
                      className="row"
                      style={{ gap: '0.6rem', alignItems: 'center' }}
                    >
                      <input type="hidden" name="hireId" value={hireId} />
                      <input type="hidden" name="disputeId" value={d.disputeId} />
                      <button type="submit" className="btn btn-primary btn-sm">
                        Ask the arbiter to rule
                      </button>
                      <span className="tiny">
                        Anyone may press this. It is the only call that costs anything.
                      </span>
                    </form>
                  )
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
      {/*
        One sentence and the two facts it is about.

        The longer version - why pinning before a dispute exists is what makes
        the terms a fact about the past - is the same on every hire, so it is
        said once in the explainer above rather than under each of them.
      */}
      <p className="tiny">
        The mandate, envelope and policy this hire ran under are fixed on the arbiter by digest,
        along with the action record, so neither side can restate them now.
      </p>
      <p className="tiny mono break" style={{ opacity: 0.6 }}>
        {pinned.recordUrl}
        <br />
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
 * have to guess whether the hirer raised this or we did. What that means for
 * the bond is said once above the list; here it is only the fact.
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
    /*
      Muted, not amber. This is context on an otherwise ordinary filing, and
      styling it as a warning made it louder than the state badge next to it -
      which is the one thing in the row a reader is actually looking for.
    */
    <span
      className="badge badge-plain tiny"
      title="Bench filed on the hirer's behalf and posted the bond. The chain records both addresses."
    >
      filed by Bench
    </span>
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
