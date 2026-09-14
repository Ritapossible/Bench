import type { DisputeRecord, EvidenceIndependence } from '@bench/core';

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

export function DisputePanel({
  available,
  locator,
  disputes,
  live,
}: {
  readonly available: boolean;
  readonly locator: { readonly chain: string; readonly address: string } | null;
  readonly disputes: readonly DisputeRecord[];
  /** Whether this hire still has authority - a dispute is only useful if it did something. */
  readonly live: boolean;
}) {
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
          a complaint about its own listing. Set <span className="mono">GENLAYER_RPC_URL</span> and{' '}
          <span className="mono">GENLAYER_ARBITER_ADDRESS</span> to turn it on.
        </p>
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

      <p className="body">
        Ruled on by an Intelligent Contract on GenLayer, where each validator fetches the evidence
        and runs the judgment itself. Not by us: we list this agent and take a cut of this hire.
      </p>
      {locator === null ? null : (
        <p className="tiny mono break" style={{ opacity: 0.6 }}>
          {locator.address}
        </p>
      )}

      {disputes.length === 0 ? (
        <p className="small">
          {live
            ? 'No dispute has been raised on this hire. Raising one costs a filing bond, which returns unless the arbiter positively finds the agent delivered.'
            : 'No dispute was raised on this hire.'}
        </p>
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
                  <p className="tiny">
                    {Date.now() < d.answerEndsAt.getTime()
                      ? `The agent has until ${d.answerEndsAt.toISOString()} to file its own evidence. Nobody can rule before then - a verdict taken on one side's documents is one side's verdict.`
                      : `Open for adjudication. Anyone may call it, and the window closes ${d.windowEndsAt.toISOString()}.`}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
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
