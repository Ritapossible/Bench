import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isThin } from '@bench/core';
import { data } from '@/lib/data/index';
import { BasisBadge, LiveBadge, ThinBadge } from '@/components/Badges';
import { CATEGORY_LABEL, ms, pct, usd, ago } from '@/lib/format';

/**
 * Revalidate on a cadence rather than prerendering once.
 *
 * These pages read the catalog, and the catalog is written by the indexer and
 * prober on their own schedule. Built statically they would freeze whatever was
 * in the database the moment the deploy ran - which during judging means a page
 * that confidently shows a stale agent count. Sixty seconds is well under the
 * probe interval, so the page is never meaningfully behind, and it still costs
 * one query per minute rather than one per visitor.
 */
export const revalidate = 60;


export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ readonly chain: string; readonly tokenId: string }>;
}) {
  const { chain, tokenId } = await params;
  const agent = await data.getAgent(chain, tokenId);
  if (!agent) notFound();

  const { record, liveness, verifiedLive } = agent.entry;
  const card = record.card;

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <Link href="/agents" className="small" style={{ textDecoration: 'none' }}>← Catalog</Link>

        {/* header */}
        <div className="stack stack-16">
          <div className="row" style={{ gap: '0.6rem' }}>
            <LiveBadge live={verifiedLive} conformant={liveness.conformant} />
            <span className="badge badge-plain">{CATEGORY_LABEL[card?.category ?? 'other']}</span>
            {agent.score ? <ThinBadge score={agent.score} /> : null}
          </div>
          <h1 className="h2">{card?.name ?? 'Unresolved agent card'}</h1>
          <p className="lead" style={{ maxWidth: '46rem' }}>{card?.description ?? record.cardError}</p>
          <p className="tiny mono break">
            {record.id.chain} · token #{record.id.tokenId.toString()} · owner {record.owner.slice(0, 10)}… · registered{' '}
            {record.registeredAt.toISOString().slice(0, 10)}
          </p>
        </div>

        {/* the two columns, never merged */}
        <div className="grid grid-2">
          <div className="slab on-dark stack stack-12">
            <div className="row-between">
              <span className="eyebrow">Simulated</span>
              {agent.score ? <BasisBadge score={agent.score} /> : null}
            </div>
            {agent.score ? (
              <>
                <div className="statnum">{usd((agent.score.normalized - 0.5) * 800, { sign: true })}</div>
                <p className="small">
                  vs do-nothing · {agent.score.window.start.toISOString().slice(0, 10)} →{' '}
                  {agent.score.window.end.toISOString().slice(0, 10)} · n={agent.score.sampleSize}
                  {isThin(agent.score) ? ' · thin sample' : ''}
                </p>
              </>
            ) : (
              <>
                <div className="statnum">-</div>
                <p className="small">No completed auditions. Listed and probed, not ranked.</p>
              </>
            )}
          </div>

          <div className="card stack stack-12">
            <div className="row-between">
              <span className="eyebrow">Realized</span>
              <span className="badge badge-plain">n=0</span>
            </div>
            <div className="statnum ink">-</div>
            <p className="small">
              No settled hires yet. Realized converges on simulated as real jobs settle; the two are never merged
              into one number.
            </p>
          </div>
        </div>

        {/* liveness */}
        <div className="card stack stack-16">
          <h2 className="h3">Liveness</h2>
          <div className="grid grid-3">
            {[
              ['Uptime', pct(liveness.uptimeBps)],
              ['p95 latency', ms(liveness.p95LatencyMs)],
              ['Probes', String(liveness.probeCount)],
              ['Last probed', liveness.lastProbedAt ? ago(liveness.lastProbedAt) : 'never'],
              ['Reachable', liveness.reachable ? 'yes' : 'no'],
              ['Speaks its protocol', liveness.conformant ? 'yes' : 'no'],
            ].map(([k, v]) => (
              <div key={k} className="stack stack-4">
                <span className="tiny">{k}</span>
                <span className="mono ink" style={{ fontSize: '1.05rem', fontWeight: 600 }}>{v}</span>
              </div>
            ))}
          </div>
          <p className="tiny">
            A rolling hash of these probes is anchored on-chain, so liveness is auditable rather than a claim Bench
            makes about itself.
          </p>
        </div>

        {/* audition runs */}
        <div className="stack stack-16">
          <div className="stack stack-8">
            <h2 className="h3">Auditions</h2>
            <p className="body" style={{ maxWidth: '46rem' }}>
              Each run records its fork block, window and seed, so anyone can re-run it and check the arithmetic -
              <span className="mono"> npx bench-replay &lt;id&gt;</span>.
            </p>
          </div>

          {agent.runs.length === 0 ? (
            <div className="card"><p className="body">No auditions have completed for this agent yet.</p></div>
          ) : (
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Window</th><th>Regime</th><th>Position</th><th>Fork block</th>
                    <th className="num">Actions</th><th className="num">vs do-nothing</th>
                    <th className="num">vs peers</th><th className="num">Max DD</th><th>Run</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.runs.map((r, i) => {
                    const o = agent.outcomes[i];
                    return (
                      <tr key={r.id}>
                        <td>{r.window.label}</td>
                        <td>{r.window.regime}</td>
                        <td>{r.position.label}</td>
                        <td className="mono">{r.window.forkBlock.toString()}</td>
                        <td className="num mono">{o?.actionCount ?? '-'}</td>
                        <td className="num mono" style={{ color: (o?.deltaVsDoNothingUsd ?? 0) < 0 ? 'var(--blocked)' : undefined }}>
                          {o ? usd(o.deltaVsDoNothingUsd, { sign: true }) : '-'}
                        </td>
                        <td className="num mono">{o?.deltaVsPeerMedianUsd != null ? usd(o.deltaVsPeerMedianUsd, { sign: true }) : '-'}</td>
                        <td className="num mono">{o ? usd(o.maxDrawdownUsd) : '-'}</td>
                        <td className="mono tiny">{r.id}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* hire */}
        <div className="slab on-dark stack stack-16">
          <span className="eyebrow">Hiring</span>
          <h2 className="h3">Bounded by what it just did.</h2>
          <p className="body" style={{ maxWidth: '44rem' }}>
            Payment through Binance x402, escrow through ERC-8183, authority through a revocable Altana session key
            scoped to a spend cap and a contract allowlist - and every transaction this agent produces simulated
            against the envelope it established above before that key will sign it.
          </p>
          <div className="row">
            <button className="btn btn-primary" disabled style={{ opacity: 0.55, cursor: 'not-allowed' }}>Hire - Phase 4</button>
            <Link href="/report" className="btn btn-ghost on-dark">See it against your own position →</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
