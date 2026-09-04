import { data, isLiveData } from '@/lib/data/index';
import { workerHealth } from '@/lib/data/worker-health';

export const metadata = {
  title: 'Status - Bench',
  description: 'What the indexer, prober, audition and scoring queues are actually doing.',
};
export const dynamic = 'force-dynamic';

const age = (s: number | null) =>
  s === null ? 'never' : s < 90 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;

const uptime = (s: number) =>
  s < 3600 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

/**
 * What the machinery is doing, said out loud.
 *
 * This page exists because "no errors" turned out to be the most expensive
 * thing this project believed. The audition queue ran forty times, reported
 * zero failures, and auditioned no agent; the scorer ran clean while
 * structurally unable to see any audited agent. Both looked healthy from every
 * counter that existed.
 *
 * So every queue reports what its last tick *did*, not that it ran, and a queue
 * that keeps completing without effect is called out rather than averaged into
 * a green light.
 */
export default async function StatusPage() {
  const [health, stats, provenance] = await Promise.all([
    workerHealth(),
    data.catalogStats(),
    data.catalogProvenance(),
  ]);

  return (
    <section className="wrap section">
      <div className="stack stack-32" style={{ maxWidth: '56rem' }}>
        <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
          <span className="eyebrow">Status</span>
          <h1 className="h2">What the machinery is doing.</h1>
          <p className="lead">
            Every queue reports what its last tick achieved, not that it ran -
            &ldquo;succeeded&rdquo; is the absence of an error, not an outcome. A quiet queue is
            normal: the prober probes every endpoint hourly and then has nothing due, and the
            audition queue waits out its re-audition floor. What is called out here is a queue with
            candidates it neither handled nor explained, which is the shape every real fault in this
            worker has taken.
          </p>
        </div>

        <div className="card stack stack-12">
          <div className="row-between">
            <h2 className="h3">Catalog</h2>
            <span className="badge badge-plain">{provenance}</span>
          </div>
          <div className="statgrid">
            <div className="statcell">
              <div className="statnum">{stats.registered}</div>
              <div className="statlabel">Registered on chain</div>
            </div>
            <div className="statcell">
              <div className="statnum">{stats.withResolvableCard}</div>
              <div className="statlabel">Card resolves</div>
            </div>
            <div className="statcell">
              <div className="statnum">{stats.verifiedLive}</div>
              <div className="statlabel">Verified live</div>
            </div>
          </div>
          {isLiveData ? null : (
            <p className="notice notice-warn" role="status">
              No database is configured, so these are fixtures rather than indexed data.
            </p>
          )}
        </div>

        <div className="card stack stack-16">
          <div className="row-between">
            <h2 className="h3">Worker</h2>
            {health.status === 'up' ? (
              <span className="badge badge-live">
                <span className="dot" /> healthy
              </span>
            ) : health.status === 'degraded' ? (
              <span className="badge badge-blocked">needs attention</span>
            ) : (
              <span className="badge badge-plain">{health.status}</span>
            )}
          </div>

          {health.status === 'unconfigured' ? (
            <p className="body">
              No worker health endpoint is configured for this deployment, so the queues cannot be
              reported here. The worker runs as a separate long-lived process - the one thing a
              serverless deployment cannot be - and publishes its own status.
            </p>
          ) : health.status === 'unreachable' ? (
            <p className="notice notice-warn" role="status">
              The worker could not be reached: {health.reason}. Indexing, probing and auditions are
              probably not running.
            </p>
          ) : (
            <>
              <p className="small">Up {uptime(health.uptimeSeconds)}.</p>

              {health.attention.length === 0 ? null : (
                <div className="notice notice-warn" role="status">
                  <ul className="stack stack-8">
                    {health.attention.map((a) => (
                      <li key={a} className="small">
                        {a}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {health.rpcRoutable === false ? (
                <div className="notice notice-warn" role="status">
                  <p className="small">
                    Auditions are running but the fork RPC has no public origin, so every agent is
                    handed an endpoint it cannot reach and will measure{' '}
                    <span className="mono">$0.00</span> whatever it would have done. Set{' '}
                    <span className="mono">BENCH_PUBLIC_RPC_BASE_URL</span> on the worker.
                  </p>
                </div>
              ) : null}

              {health.detailWithheld ? (
                <div className="notice notice-warn" role="status">
                  <p className="small">
                    The worker is up but withheld its per-queue detail, because this deployment
                    holds no <span className="mono">BENCH_WORKER_HEALTH_TOKEN</span>. That detail
                    includes each queue&rsquo;s last failure message, which is why it is not public
                    by default.
                  </p>
                </div>
              ) : null}

              <div className="tablewrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Queue</th>
                      <th className="num">Ticks</th>
                      <th className="num">Failures</th>
                      <th>Last ran</th>
                      <th>What it did</th>
                    </tr>
                  </thead>
                  <tbody>
                    {health.queues.map((q) => (
                      <tr key={q.name}>
                        <td className="mono tiny">{q.name.replace('bench-', '')}</td>
                        <td className="num mono">{q.ticks}</td>
                        <td
                          className="num mono"
                          style={{ color: q.failures > 0 ? 'var(--blocked)' : undefined }}
                        >
                          {q.failures}
                        </td>
                        <td className="tiny">{age(q.secondsSinceLastOk)}</td>
                        <td className="tiny">
                          {q.lastFailure !== null && q.failures > 0 ? (
                            <span className="ink">{q.lastFailure}</span>
                          ) : (
                            (q.lastResult ?? 'not yet reported')
                          )}
                          {q.idleStreak >= 5 ? (
                            <>
                              {' '}
                              <span className="badge badge-blocked">
                                {q.idleStreak} ticks unaccounted for
                              </span>
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        <p className="small">
          A queue registers only when the things it needs exist - auditions stay off without an
          archive node, and probe anchoring without a funded signer - so a missing queue here is a
          feature that is switched off rather than one that is broken. The worker says which at
          startup.
        </p>
      </div>
    </section>
  );
}
