'use client';

import { useMemo, useState } from 'react';
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

export function CatalogFilter({ rows }: { readonly rows: readonly AgentRow[] }) {
  const [liveOnly, setLiveOnly] = useState(true);
  const [category, setCategory] = useState<string>('all');

  const shown = useMemo(
    () =>
      rows.filter(
        (r) => (!liveOnly || r.verifiedLive) && (category === 'all' || r.category === category),
      ),
    [rows, liveOnly, category],
  );

  /**
   * How many agents each chip would show, under the live-only toggle as it
   * stands.
   *
   * Agent Diversity is scored on all four categories being surfaced with equal
   * depth, and a row of chips alone cannot show whether that is true - four
   * equal-looking buttons over 40, 0, 0 and 3 agents look exactly like four
   * over a balanced catalog. The count is what makes the claim checkable, and
   * it is deliberately shown even when it is zero: an empty category is a fact
   * about the registry, and hiding it would be the one thing this catalog is
   * built not to do.
   */
  const counts = useMemo(() => {
    const eligible = rows.filter((r) => !liveOnly || r.verifiedLive);
    const by = new Map<string, number>([['all', eligible.length]]);
    for (const r of eligible) by.set(r.category, (by.get(r.category) ?? 0) + 1);
    return by;
  }, [rows, liveOnly]);

  return (
    <div className="stack stack-24">
      <div className="filters">
        <div className="filter-chips" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              aria-pressed={category === c}
              className={category === c ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
            >
              {c === 'all' ? 'All' : CATEGORY_LABEL[c]}{' '}
              <span className="chip-count">{counts.get(c) ?? 0}</span>
            </button>
          ))}
        </div>

        <label className="filter-toggle">
          <input
            type="checkbox"
            checked={liveOnly}
            onChange={(e) => setLiveOnly(e.target.checked)}
          />
          <span className="small ink" style={{ whiteSpace: 'nowrap' }}>
            Verified live only
          </span>
        </label>
      </div>

      <p className="small">
        Showing <strong className="ink">{shown.length}</strong> of {rows.length} indexed.{' '}
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
                {r.deltaUsd === null ? (
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
