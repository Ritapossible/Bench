import { isThin, type Score } from '@bench/core';

export function LiveBadge({ live, conformant }: { readonly live: boolean; readonly conformant: boolean }) {
  if (live) {
    return (
      <span className="badge badge-live">
        <span className="dot" /> Verified live
      </span>
    );
  }
  return (
    <span className="badge badge-dead">
      {conformant ? 'Not verified' : 'Non-conformant'}
    </span>
  );
}

/** A score is never rendered without its basis and its sample size. */
export function BasisBadge({ score }: { readonly score: Score }) {
  return (
    <span className={score.basis === 'realized' ? 'badge badge-real' : 'badge badge-sim'}>
      {score.basis === 'realized' ? 'Realized' : 'Simulated'} · n={score.sampleSize}
    </span>
  );
}

export function ThinBadge({ score }: { readonly score: Score }) {
  if (!isThin(score)) return null;
  return <span className="badge badge-thin">Thin sample</span>;
}
