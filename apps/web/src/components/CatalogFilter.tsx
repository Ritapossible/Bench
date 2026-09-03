import Link from 'next/link';
import { CATEGORY_LABEL, usd, pct, ms } from '@/lib/format';

/**
 * Plain view model. Server components cannot hand a client component a bigint
 * or a Date, and the boundary is a good place to decide exactly what the UI is
 * allowed to see anyway.
 */
export interface AgentRow {
  readonly href: string;
  readonly tokenId: string;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly verifiedLive: boolean;
  readonly conformant: boolean;
  readonly uptimeBps: number;
  readonly p95LatencyMs: number | null;
  readonly probeCount: number;
  /**
   * Whether Bench can drive this agent at all.
   *
   * An unranked agent said "Listed, probed, unranked" whether it was waiting
   * its turn or could never be auditioned, and those are different facts about
   * an agent. Derived from the card's endpoints, so it costs no storage: an
   * agent declaring neither A2A nor MCP has no interface to be handed a task
   * through, and no amount of waiting will change that.
   */
  readonly drivable: boolean;
  /** Null when the agent has no completed auditions. Never faked. */
  readonly deltaUsd: number | null;
  readonly sampleSize: number;
  readonly thin: boolean;
  /**
   * Auditions attempted that failed, and why the last one did.
   *
   * Zero with a null `deltaUsd` means the queue has not reached this agent.
   * Non-zero means it did, and the agent could not be driven - a result, and
   * for most of this catalog the only result there is. Both used to render as
   * "No auditions yet - queued for audition", which was false for the second
   * group and made the audition queue look idle when it was working.
   */
  readonly failedAuditions: number;
  readonly failureReason: string | null;
}

/**
 * The four judged categories lead, in the contest's own order. Agent Diversity
 * is one of three main-track criteria and requires all four surfaced with
 * equal depth, so the filter presents them as peers rather than burying three
 * of them behind a dropdown.
 */
const CATEGORIES = [
  'all',
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
  'monitoring',
  'other',
] as const;

/**
 * A server component, deliberately.
 *
 * This filtered in the browser over whatever page had loaded, which made the
 * chip counts a statement about the slice rather than the catalog - four
 * equal-looking buttons over 40, 0, 0 and 3 agents look exactly like four over
 * a balanced one, and Agent Diversity is a third of the main-track score. It
 * also meant the selection lived in React state, so `?category=grid` did
 * nothing and a judge could not link anyone to a category.
 *
 * The counts now come from one grouped SQL count over the whole catalog, the
 * rows come back already filtered, and each chip is a real link. An empty
 * category still shows its zero: that is a fact about the registry, and hiding
 * it is the one thing this catalog is built not to do.
 */
export function CatalogFilter({
  rows,
  counts,
  category,
  liveOnly,
  totalIndexed,
}: {
  readonly rows: readonly AgentRow[];
  readonly counts: Readonly<Record<string, number>>;
  readonly category: string;
  readonly liveOnly: boolean;
  readonly totalIndexed: number;
}) {
  const href = (next: { category?: string; live?: boolean }): string => {
    const c = next.category ?? category;
    const l = next.live ?? liveOnly;
    const params = new URLSearchParams();
    if (c !== 'all') params.set('category', c);
    if (!l) params.set('live', 'false');
    const q = params.toString();
    return q === '' ? '/agents' : `/agents?${q}`;
  };

  const shown = rows;

  return (
    <div className="stack stack-24">
      <div className="filters">
        <div className="filter-chips" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={href({ category: c })}
              aria-current={category === c ? 'page' : undefined}
              className={category === c ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
              style={{ textDecoration: 'none' }}
            >
              {c === 'all' ? 'All' : CATEGORY_LABEL[c]}{' '}
              <span className="chip-count">{counts[c] ?? 0}</span>
            </Link>
          ))}
        </div>

        <Link
          href={href({ live: !liveOnly })}
          className="filter-toggle"
          style={{ textDecoration: 'none' }}
        >
          <input type="checkbox" checked={liveOnly} readOnly tabIndex={-1} aria-hidden="true" />
          <span className="small ink" style={{ whiteSpace: 'nowrap' }}>
            Verified live only
          </span>
        </Link>
      </div>

      <p className="small">
        Showing <strong className="ink">{shown.length}</strong> of{' '}
        {category === 'all' ? totalIndexed : (counts[category] ?? 0)}{' '}
        {category === 'all' ? 'indexed' : `${CATEGORY_LABEL[category] ?? category} agents`}
        {shown.length < (category === 'all' ? totalIndexed : (counts[category] ?? 0))
          ? ' (first page)'
          : ''}
        .{' '}
        {liveOnly
          ? 'Verified live means the endpoint responded and spoke the protocol its card declares - not merely returned 200.'
          : 'Filter off: this is what a raw registry read looks like.'}
      </p>

      <div className="stack stack-12">
        {shown.map((r) => (
          <Link key={r.tokenId} href={r.href} className="card card-link">
            <div className="sumcard">
              <div className="sumcard-head">
                <h3 className="h4">{r.name}</h3>
                {r.verifiedLive ? (
                  <span className="badge badge-live">
                    <span className="dot" /> Verified live
                  </span>
                ) : (
                  <span className="badge badge-dead">
                    {r.conformant ? 'Not verified' : 'Non-conformant'}
                  </span>
                )}
                {r.thin ? <span className="badge badge-thin">Thin sample</span> : null}
              </div>

              <div className="sumcard-score">
                {r.deltaUsd === null && r.failedAuditions > 0 ? (
                  <>
                    <span className="small ink">Could not be driven</span>
                    <span className="tiny">
                      {r.failedAuditions} audition{r.failedAuditions === 1 ? '' : 's'} attempted,
                      none completed
                      {r.failureReason === null ? '' : ` - ${r.failureReason}`}
                    </span>
                  </>
                ) : r.deltaUsd === null ? (
                  <>
                    <span className="small ink">No auditions yet</span>
                    <span className="tiny">
                      {r.drivable
                        ? r.verifiedLive
                          ? 'Queued for audition'
                          : 'Not verified live - cannot be auditioned yet'
                        : 'No A2A or MCP endpoint to drive'}
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="mono sumcard-value"
                      style={{ color: r.deltaUsd < 0 ? 'var(--blocked)' : 'var(--ink)' }}
                    >
                      {usd(r.deltaUsd, { sign: true })}
                    </span>
                    <span className="tiny">
                      vs doing nothing · {r.sampleSize} audition
                      {r.sampleSize === 1 ? '' : 's'} on a forked chain
                    </span>
                  </>
                )}
              </div>

              <div className="sumcard-body">
                <p className="body">{r.description || 'Agent card did not resolve.'}</p>
                <p className="tiny mono">
                  #{r.tokenId} · {CATEGORY_LABEL[r.category] ?? r.category} · uptime{' '}
                  {pct(r.uptimeBps)} · p95 {ms(r.p95LatencyMs)} · {r.probeCount} probes
                </p>
              </div>
            </div>
          </Link>
        ))}

        {shown.length === 0 ? (
          <div className="card">
            <p className="body">Nothing matches. Loosen a filter.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
