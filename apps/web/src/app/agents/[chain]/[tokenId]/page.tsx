import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isThin } from '@bench/core';
import { data } from '@/lib/data/index';
import { AgentAvatar } from '@/components/AgentAvatar';
import { BasisBadge, LiveBadge, ThinBadge } from '@/components/Badges';
import { CATEGORY_LABEL, ms, pct, usd, ago } from '@/lib/format';

/**
 * Rendered per request, not prerendered at build time.
 *
 * These pages read the catalog, so prerendering them makes `next build` depend
 * on a reachable, migrated database - and the build and the database are
 * independently available in every deployment that matters. CI caught it
 * first: the same `npm run build` passed without DATABASE_URL and failed with
 * it, against a database whose migrations had not run yet. On Vercel the same
 * shape means a brief database blip fails a deploy that had nothing to do with
 * the database.
 *
 * The cost is a handful of queries per request instead of one per minute, which
 * at this traffic is not a cost. The gain is that the catalog is never stale -
 * which matters more than it sounds when the thing being judged is whether the
 * agents are live *now*.
 */
export const dynamic = 'force-dynamic';

export default async function AgentPage({
  params,
}: {
  readonly params: Promise<{ readonly chain: string; readonly tokenId: string }>;
}) {
  const { chain, tokenId } = await params;
  const [agent, anchoring] = await Promise.all([
    data.getAgent(chain, tokenId),
    data.probeAnchoring(),
  ]);
  if (!agent) notFound();

  const { record, liveness, verifiedLive } = agent.entry;
  const card = record.card;
  // An agent that could not be driven is the finding, so a failed run shows
  // why rather than a dash in every numeric column.
  const outcomeByRun = new Map(agent.outcomes.map((o) => [o.runId, o]));

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <Link href="/agents" className="small" style={{ textDecoration: 'none' }}>
          ← Catalog
        </Link>

        {/* header */}
        <div className="stack stack-16">
          <div className="row" style={{ gap: '0.6rem' }}>
            <LiveBadge live={verifiedLive} conformant={liveness.conformant} />
            <span className="badge badge-plain">{CATEGORY_LABEL[card?.category ?? 'other']}</span>
            {agent.score ? <ThinBadge score={agent.score} /> : null}
          </div>
          <div className="row" style={{ gap: '0.9rem', alignItems: 'center' }}>
            <AgentAvatar src={card?.image} name={card?.name ?? 'Unresolved agent'} size={56} />
            <h1 className="h2">{card?.name ?? 'Unresolved agent card'}</h1>
          </div>
          <p className="lead" style={{ maxWidth: '46rem' }}>
            {card?.description ?? record.cardError}
          </p>
          <p className="tiny mono break">
            {record.id.chain} · token #{record.id.tokenId.toString()} · owner{' '}
            {record.owner.slice(0, 10)}…
            {/*
              Agents discovered by enumeration have no registration date:
              ownerOf and tokenURI are current state and carry no timestamp, and
              the event that would is in pruned history. The epoch is the
              placeholder for that, and printing it as "1970-01-01" states a
              date nobody knows. Omitted instead - a missing fact beats a wrong
              one, and this one is missing for a reason worth not papering over.
            */}
            {record.registeredAt.getTime() === 0
              ? null
              : ` · registered ${record.registeredAt.toISOString().slice(0, 10)}`}
          </p>
        </div>

        {/* the two columns, never merged */}
        <p className="small" style={{ maxWidth: '44rem' }}>
          Driven at its own endpoint against a fork of BNB Chain pinned to a real block, holding a
          real position at real prices. Only the execution is simulated: transactions ran against
          the fork rather than being broadcast.
        </p>
        <div className="grid grid-2">
          <div className="slab on-dark stack stack-12">
            <div className="row-between">
              <span className="eyebrow">From auditions</span>
              {agent.score ? <BasisBadge score={agent.score} /> : null}
            </div>
            {agent.score ? (
              <>
                <div className="statnum">{usd(agent.score.meanDeltaUsd, { sign: true })}</div>
                <p className="small">
                  Against the same position left alone, over {agent.score.sampleSize} audition
                  {agent.score.sampleSize === 1 ? '' : 's'} on a forked chain
                  {agent.score.capitalUsd > 0 ? ` with ${usd(agent.score.capitalUsd)} at risk` : ''}
                  .{isThin(agent.score) ? ' Too few to be a track record yet.' : ''}
                </p>
                {/* The dates were rendered as a range and read as an error when
                    there is one audition: "2026-09-03 → 2026-09-03". A single
                    date is the truthful rendering of a single measurement. */}
                <p className="tiny">
                  {agent.score.window.start.toISOString().slice(0, 10) ===
                  agent.score.window.end.toISOString().slice(0, 10)
                    ? `Measured ${agent.score.window.end.toISOString().slice(0, 10)}`
                    : `${agent.score.window.start.toISOString().slice(0, 10)} → ${agent.score.window.end.toISOString().slice(0, 10)}`}
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
              <span className="eyebrow">From settled hires</span>
              <span className="badge badge-plain">n=0</span>
            </div>
            <div className="statnum ink">-</div>
            <p className="small">
              No settled hires yet. This column fills as real jobs settle and converges on the
              audition figure; the two are never merged into one number.
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
                <span className="mono ink" style={{ fontSize: '1.05rem', fontWeight: 600 }}>
                  {v}
                </span>
              </div>
            ))}
          </div>
          <p className="tiny">
            {anchoring.anchored
              ? 'A rolling hash of these probes is anchored on-chain, so liveness is auditable rather than a claim Bench makes about itself.'
              : 'Probe results are hash-chained and stored. On-chain anchoring - which is what would make them auditable by someone who does not trust Bench - is not live on this deployment yet.'}
          </p>
        </div>

        {/* audition runs */}
        <div className="stack stack-16">
          <div className="stack stack-8">
            <h2 className="h3">Auditions</h2>
            <p className="body" style={{ maxWidth: '46rem' }}>
              Each run records its fork block, window and seed, so anyone can re-run it and check
              the arithmetic -<span className="mono"> npx bench-replay &lt;id&gt;</span>.
            </p>
          </div>

          {agent.runs.length === 0 ? (
            <div className="card">
              <p className="body">No auditions have completed for this agent yet.</p>
            </div>
          ) : (
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Window</th>
                    <th>Regime</th>
                    <th>Position</th>
                    <th>Fork block</th>
                    <th className="num">Actions</th>
                    <th className="num">vs do-nothing</th>
                    <th className="num">vs peers</th>
                    <th className="num">Max DD</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.runs.map((r) => {
                    // Keyed by run id, not by array index. The two lists are
                    // ordered independently and a failed run has no outcome at
                    // all, so index pairing silently showed one run's numbers
                    // against another run's row - and the row most likely to be
                    // mispaired is the failed one, which is the row that
                    // matters most.
                    const o = outcomeByRun.get(r.id);
                    return (
                      <tr key={r.id}>
                        <td>{r.window.label}</td>
                        <td>{r.window.regime}</td>
                        <td>{r.position.label}</td>
                        <td className="mono">{r.window.forkBlock.toString()}</td>
                        <td className="num mono">{o?.actionCount ?? '-'}</td>
                        <td
                          className="num mono"
                          style={{
                            color: (o?.deltaVsDoNothingUsd ?? 0) < 0 ? 'var(--blocked)' : undefined,
                          }}
                        >
                          {o ? usd(o.deltaVsDoNothingUsd, { sign: true }) : '-'}
                        </td>
                        <td className="num mono">
                          {o?.deltaVsPeerMedianUsd != null
                            ? usd(o.deltaVsPeerMedianUsd, { sign: true })
                            : '-'}
                        </td>
                        <td className="num mono">{o ? usd(o.maxDrawdownUsd) : '-'}</td>
                        <td className="tiny">
                          {r.status === 'complete' ? (
                            <span className="badge badge-live">completed</span>
                          ) : (
                            <>
                              <span className="badge badge-blocked">{r.status}</span>{' '}
                              <span className="ink">{r.failureReason ?? 'no reason recorded'}</span>
                            </>
                          )}
                        </td>
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
            A mandate bounds spend, recipients and expiry; the envelope above bounds behaviour. Both
            are enforced here. Payment and escrow are simulated.
          </p>
          <div className="row">
            {/* The checkout behind this has been live and reachable by URL the
                whole time: five bounded confirmations, a real mandate, a real
                consent record, a real decision trace. Only this button was
                disabled - so the one path a reader takes from "this agent is
                good" to "put it to work" was a dead control, and the journey
                this marketplace exists to serve ended one click short.
                Settlement is what is still simulated, and the checkout says so
                on the step where that matters rather than here, where it would
                only discourage the click. */}
            <Link href={`/agents/${chain}/${tokenId}/hire`} className="btn btn-primary">
              Hire this agent →
            </Link>
            <Link href="/report" className="btn btn-ghost on-dark">
              See it against your own position →
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
