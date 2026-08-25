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
  /** Null when the agent has no completed auditions. Never faked. */
  readonly deltaUsd: number | null;
  readonly sampleSize: number;
  readonly thin: boolean;
}

const CATEGORIES = ['all', 'yield', 'health-factor', 'grid', 'monitoring', 'other'] as const;

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

  return (
    <div className="stack stack-24">
      <div className="row-between">
        <div className="row" style={{ gap: '0.5rem' }}>
          {CATEGORIES.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={category === c ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
            >
              {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
            </button>
          ))}
        </div>

        <label className="row" style={{ gap: '0.5rem', cursor: 'pointer' }}>
          <input type="checkbox" checked={liveOnly} onChange={(e) => setLiveOnly(e.target.checked)} />
          <span className="small ink">Verified live only</span>
        </label>
      </div>

      <p className="small">
        Showing <strong className="ink">{shown.length}</strong> of {rows.length} indexed.{' '}
        {liveOnly
          ? 'Verified live means the endpoint responded and spoke the protocol its card declares — not merely returned 200.'
          : 'Filter off: this is what a raw registry read looks like.'}
      </p>

      <div className="stack stack-12">
        {shown.map((r) => (
          <Link key={r.tokenId} href={r.href} className="card card-link">
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div className="stack stack-8" style={{ flex: '1 1 20rem' }}>
                <div className="row" style={{ gap: '0.6rem' }}>
                  <h3 className="h4">{r.name}</h3>
                  {r.verifiedLive ? (
                    <span className="badge badge-live"><span className="dot" /> Verified live</span>
                  ) : (
                    <span className="badge badge-dead">{r.conformant ? 'Not verified' : 'Non-conformant'}</span>
                  )}
                  {r.thin ? <span className="badge badge-thin">Thin sample</span> : null}
                </div>
                <p className="body" style={{ maxWidth: '44rem' }}>{r.description || 'Agent card did not resolve.'}</p>
                <p className="tiny mono">
                  #{r.tokenId} · {CATEGORY_LABEL[r.category] ?? r.category} · uptime {pct(r.uptimeBps)} · p95{' '}
                  {ms(r.p95LatencyMs)} · {r.probeCount} probes
                </p>
              </div>

              <div className="stack stack-4" style={{ textAlign: 'right', minWidth: '10rem' }}>
                {r.deltaUsd === null ? (
                  <>
                    <span className="small">No auditions yet</span>
                    <span className="tiny">Listed, probed, unranked</span>
                  </>
                ) : (
                  <>
                    <span
                      className="mono"
                      style={{ fontSize: '1.35rem', fontWeight: 700, color: r.deltaUsd < 0 ? 'var(--blocked)' : 'var(--ink)' }}
                    >
                      {usd(r.deltaUsd, { sign: true })}
                    </span>
                    <span className="tiny">vs do-nothing · simulated · n={r.sampleSize}</span>
                  </>
                )}
              </div>
            </div>
          </Link>
        ))}

        {shown.length === 0 ? (
          <div className="card"><p className="body">Nothing matches. Loosen a filter.</p></div>
        ) : null}
      </div>
    </div>
  );
}
