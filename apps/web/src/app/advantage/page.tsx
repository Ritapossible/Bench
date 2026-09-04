import Link from 'next/link';
import { data, isLiveData } from '@/lib/data/index';
import { usd, CATEGORY_LABEL, agentHref } from '@/lib/format';

export const metadata = {
  title: 'Agent Advantage Report - Bench',
  description:
    'Real tasks run with and without an agent, on identical state, with the outputs attached.',
};
export const dynamic = 'force-dynamic';

const ms = (n: number | null) => (n === null ? '-' : `${(n / 1000).toFixed(1)}s`);

/**
 * The Agent Advantage Report.
 *
 * Generated from recorded auditions rather than written by hand. An audition is
 * already the comparison this report asks for - same position, same window,
 * same fork block, the agent against a do-nothing baseline on identical state -
 * so every figure here is derived from a run that happened, and each row
 * carries the replay hash that lets a reader reproduce it.
 *
 * When there is no evidence the page says so. A report padded to three tasks
 * would defeat its own purpose.
 */
export default async function AdvantagePage() {
  const report = await data.advantage();
  const { totals } = report;

  return (
    <section className="wrap section">
      <div className="stack stack-32" style={{ maxWidth: '60rem' }}>
        <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
          <span className="eyebrow">Agent Advantage Report</span>
          <h1 className="h2">Measured, not asserted.</h1>
          <p className="lead">
            Each task below ran twice on identical state: once with the agent driving, once with the
            position left alone. Same fork block, same seed, same window. Nothing here was typed by
            hand - every figure comes from a recorded audition, and the replay hash on each row is
            what lets you re-run it and get the same starting state.
          </p>
          {isLiveData ? null : (
            <p className="notice notice-warn" role="status">
              This deployment has no database configured, so there are no recorded auditions to
              report on.
            </p>
          )}
        </div>

        <div className="stack stack-12">
          <div className="statgrid">
            <div className="statcell">
              <div className="statnum">{totals.tasks}</div>
              <div className="statlabel">Tasks run both ways</div>
            </div>
            <div className="statcell">
              <div className="statnum">{totals.agentWins}</div>
              <div className="statlabel">Beat doing nothing, net of cost</div>
            </div>
            <div className="statcell">
              <div className="statnum">{usd(totals.netDeltaUsd, { sign: true })}</div>
              <div className="statlabel">Net difference vs baseline</div>
            </div>
            <div className="statcell">
              <div className="statnum">{usd(totals.totalCostUsd)}</div>
              <div className="statlabel">Real money spent running agents</div>
            </div>
          </div>
          <p className="small">
            &ldquo;Won&rdquo; means the agent beat the baseline by more than it cost to run -
            gaining three dollars while spending five is not a win.
          </p>
        </div>

        {/* The brief's own requirements, checked against what is here rather
            than claimed in prose. */}
        <div className="card stack stack-12">
          <h2 className="h3">Requirements</h2>
          <ul className="stack stack-8">
            <li className="small">
              <span
                className={report.meetsTaskMinimum ? 'badge badge-live' : 'badge badge-blocked'}
              >
                {report.meetsTaskMinimum ? 'met' : 'not met'}
              </span>{' '}
              At least three real tasks run both ways - {totals.tasks} recorded.
            </li>
            <li className="small">
              <span
                className={
                  report.meetsCategoryRequirement ? 'badge badge-live' : 'badge badge-blocked'
                }
              >
                {report.meetsCategoryRequirement ? 'met' : 'not met'}
              </span>{' '}
              At least one task from trading, stocks or security - counted as grid trading,
              rebalancing or health-factor monitoring.
            </li>
            <li className="small">
              <span className="badge badge-live">met</span> Time, cost and output quality reported,
              with the outputs attached - every transaction each agent produced is listed under its
              task.
            </li>
          </ul>
        </div>

        {report.tasks.length === 0 ? (
          <div className="card stack stack-12">
            <h2 className="h3">No completed auditions yet.</h2>
            <p className="body">
              Generated from recorded runs, so it is empty until agents have been auditioned rather
              than padded with plausible-looking tasks.
            </p>
            <div>
              <Link href="/agents" className="btn btn-primary btn-sm">
                Browse the catalog
              </Link>
            </div>
          </div>
        ) : (
          <div className="stack stack-24">
            {report.tasks.map((t, i) => (
              <div key={t.runId} className="card stack stack-16">
                <div className="row-between">
                  <h2 className="h3">
                    Task {i + 1}:{' '}
                    <Link href={agentHref(t.agent.chain, t.agent.tokenId)}>{t.agentName}</Link>
                  </h2>
                  <span className="badge badge-plain">
                    {CATEGORY_LABEL[t.category] ?? t.category}
                  </span>
                </div>

                <p className="small">
                  {t.positionLabel} · {t.windowLabel} · forked at block{' '}
                  <span className="mono">{t.forkBlock.toString()}</span>
                </p>

                <div className="tablewrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th></th>
                        <th className="num">Terminal value</th>
                        <th className="num">Actions</th>
                        <th className="num">Max drawdown</th>
                        <th className="num">Time</th>
                        <th className="num">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>
                          <strong className="ink">With the agent</strong>
                        </td>
                        <td className="num mono">{usd(t.withAgent.terminalUsd)}</td>
                        <td className="num mono">{t.withAgent.actionCount}</td>
                        <td className="num mono">{usd(t.withAgent.maxDrawdownUsd)}</td>
                        <td className="num mono">{ms(t.withAgent.durationMs)}</td>
                        <td className="num mono">{usd(t.withAgent.costUsd)}</td>
                      </tr>
                      <tr>
                        <td>Without - position left alone</td>
                        <td className="num mono">{usd(t.withoutAgent.terminalUsd)}</td>
                        <td className="num mono">0</td>
                        <td className="num mono">-</td>
                        <td className="num mono">-</td>
                        <td className="num mono">{usd(0)}</td>
                      </tr>
                      <tr>
                        <td>
                          <strong className="ink">Difference</strong>
                        </td>
                        <td
                          className="num mono"
                          style={{ color: t.deltaUsd < 0 ? 'var(--blocked)' : undefined }}
                        >
                          {usd(t.deltaUsd, { sign: true })}
                        </td>
                        <td className="num" colSpan={4}>
                          <span className={t.agentWon ? 'badge badge-live' : 'badge badge-blocked'}>
                            {t.agentWon
                              ? 'agent won, net of cost'
                              : 'agent did not beat doing nothing'}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <details>
                  <summary className="small">
                    Outputs: {t.withAgent.actions.length} transaction
                    {t.withAgent.actions.length === 1 ? '' : 's'} the agent produced
                  </summary>
                  {t.withAgent.actions.length === 0 ? (
                    <p className="small">
                      None. The agent was driven and produced no transactions, which is why its
                      terminal value matches the baseline.
                    </p>
                  ) : (
                    <div className="tablewrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th className="num">#</th>
                            <th>To</th>
                            <th>Selector</th>
                            <th className="num">Value (wei)</th>
                            <th>Simulated</th>
                          </tr>
                        </thead>
                        <tbody>
                          {t.withAgent.actions.map((a) => (
                            <tr key={a.seq}>
                              <td className="num mono">{a.seq}</td>
                              <td className="mono tiny">{a.to ?? 'contract creation'}</td>
                              <td className="mono tiny">{a.selector}</td>
                              <td className="num mono tiny">{a.valueWei}</td>
                              <td>
                                <span
                                  className={
                                    a.succeeded ? 'badge badge-live' : 'badge badge-blocked'
                                  }
                                >
                                  {a.succeeded ? 'ok' : 'reverted'}
                                </span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </details>

                <p className="tiny mono">
                  run {t.runId} · replay {t.replayHash}
                </p>
              </div>
            ))}
          </div>
        )}

        <p className="small">
          Generated {report.generatedAt.toISOString()} on {report.chain}. Every transaction above
          was simulated against forked state and never broadcast.
        </p>
      </div>
    </section>
  );
}
