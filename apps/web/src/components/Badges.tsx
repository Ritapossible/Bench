import { isThin, type Score } from '@bench/core';

/**
 * Three states, not two.
 *
 * "Non-conformant" is a measurement, and this badge was printing it for agents
 * nobody had measured. The catalog holds tens of thousands of agents and the
 * prober reaches two hundred a tick, so on the day this was written almost
 * every row on the site was asserting a probe result that did not exist -
 * including Bench's own reference agent, minted an hour earlier, whose
 * endpoint answers JSON-RPC correctly. An unprobed agent is unmeasured, and
 * saying so is both honest and more useful: it tells a reader the queue has
 * not reached this one yet rather than that it failed.
 */
export function LiveBadge({
  live,
  conformant,
  probed,
}: {
  readonly live: boolean;
  readonly conformant: boolean;
  readonly probed: boolean;
}) {
  if (live) {
    return (
      <span className="badge badge-live">
        <span className="dot" /> Verified live
      </span>
    );
  }
  if (!probed) return <span className="badge badge-plain">Not probed yet</span>;
  return <span className="badge badge-dead">{conformant ? 'Not verified' : 'Non-conformant'}</span>;
}

/**
 * A score is never rendered without its basis and its sample size.
 *
 * The basis is called "audition", not "simulated". Both words are true of the
 * same number and only one of them is useful: the measurement is real - a real
 * agent driven at its real endpoint against a real fork of BNB Chain, with real
 * market state - and what is simulated is only that its transactions were
 * executed against that fork instead of being broadcast. Calling the result
 * "simulated" made a measured finding read as a fabricated one, which is the
 * opposite of what this label exists to do.
 */
export function BasisBadge({ score }: { readonly score: Score }) {
  return (
    <span className={score.basis === 'realized' ? 'badge badge-real' : 'badge badge-sim'}>
      {score.basis === 'realized' ? 'Settled hires' : 'Audition'} · n={score.sampleSize}
    </span>
  );
}

export function ThinBadge({ score }: { readonly score: Score }) {
  if (!isThin(score)) return null;
  return <span className="badge badge-thin">Thin sample</span>;
}
