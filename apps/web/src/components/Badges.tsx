import { isThin, type Score } from '@bench/core';

export function LiveBadge({
  live,
  conformant,
}: {
  readonly live: boolean;
  readonly conformant: boolean;
}) {
  if (live) {
    return (
      <span className="badge badge-live">
        <span className="dot" /> Verified live
      </span>
    );
  }
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
