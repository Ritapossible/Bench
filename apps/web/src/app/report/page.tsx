import Link from 'next/link';
import { data, isLiveData } from '@/lib/data/index';
import { CATEGORY_LABEL, usd, agentHref } from '@/lib/format';

export const metadata = {
  title: 'Your position’s report - Bench',
  description: 'Paste any BSC address and see what each agent would have done with that position. No wallet needed.',
};

const EXAMPLE = '0x7a16ff8270133f063aab6c9977183d9e72835428';

export default async function ReportPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly address?: string }>;
}) {
  const { address } = await searchParams;
  const result = address ? await data.reportForAddress(address.trim()) : null;
  const report = result?.status === 'ok' ? result.report : null;
  const invalid = result?.status === 'invalid-address';
  const notAudited = result?.status === 'not-audited' ? result.address : null;

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '46rem' }}>
          <span className="eyebrow">No wallet · no signature</span>
          <h1 className="h2">What would an agent have done with your position?</h1>
          <p className="lead">
            The position is public state and the audition is a simulation, so nothing here needs you to connect
            anything. Paste an address - the resulting report is a link you can share.
          </p>
        </div>

        {/* A plain GET form: the address lands in the URL, which is the point. */}
        <form method="get" className="row" style={{ gap: '0.75rem' }}>
          <input
            className="field"
            name="address"
            defaultValue={address ?? ''}
            placeholder="0x…"
            aria-label="BSC address"
            inputMode="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            style={{ flex: '1 1 16rem' }}
          />
          <button className="btn btn-primary" type="submit" style={{ flex: '1 1 auto' }}>
            Read the report
          </button>
        </form>

        {invalid ? (
          <div className="card stack stack-8">
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>That does not look like a BSC address.</p>
            <p className="body">
              Expected 40 hex characters after <span className="mono">0x</span>. Try the example:{' '}
              <Link href={`/report?address=${EXAMPLE}`} className="mono break">{EXAMPLE}</Link>
            </p>
          </div>
        ) : null}

        {notAudited !== null ? (
          <div className="card stack stack-8">
            <p className="quote">No audition has been run against this position yet.</p>
            <p className="body">
              The comparison is a shadow run against <span className="mono break">{notAudited}</span> specifically -
              same position, same window, every agent in parallel. Until that run exists there is no number to show,
              and a figure derived from unrelated auditions would look like a result while being a guess.
            </p>
            <p className="body">
              Browse the <Link href="/catalog">catalog</Link> for what each agent has already been auditioned on.
            </p>
          </div>
        ) : null}

        {!address ? (
          <div className="card stack stack-12">
            <h2 className="h3">Try it on a live position</h2>
            <p className="body">
              {isLiveData
                ? 'Reports are computed by replaying your position through every verified-live agent in parallel, on a fork of BSC. Nothing is signed and nothing is spent.'
                : 'This deployment reads testnet fixtures while the shadow engine is being built, so any well-formed address returns a sample PancakeSwap LP position.'}
            </p>
            <div>
              <Link href={`/report?address=${EXAMPLE}`} className="btn btn-outline btn-sm mono break" style={{ maxWidth: '100%' }}>
                {EXAMPLE}
              </Link>
            </div>
          </div>
        ) : null}

        {report ? (
          <div className="stack stack-24">
            <div className="slab on-dark stack stack-12">
              <span className="eyebrow">Position found</span>
              <h2 className="h3">{report.positionLabel}</h2>
              <div className="row" style={{ gap: '1.5rem 2.5rem' }}>
                <div className="stack stack-4">
                  <span className="tiny">Value</span>
                  <span className="mono" style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}>{usd(report.positionValueUsd)}</span>
                </div>
                <div className="stack stack-4">
                  <span className="tiny">Window</span>
                  <span className="mono" style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}>{report.windowLabel}</span>
                </div>
                <div className="stack stack-4">
                  <span className="tiny">Agents auditioned</span>
                  <span className="mono" style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}>{report.lines.length}</span>
                </div>
              </div>
              <p className="small mono break">{report.address}</p>
            </div>

            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Agent</th><th>Category</th><th className="num">Actions</th>
                    <th className="num">vs doing nothing</th><th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td><strong>Do nothing</strong></td>
                    <td className="small">baseline</td>
                    <td className="num mono">0</td>
                    <td className="num mono">{usd(0, { sign: true })}</td>
                    <td></td>
                  </tr>
                  {[...report.lines]
                    .sort((a, b) => b.deltaUsd - a.deltaUsd)
                    .map((l) => (
                      <tr key={l.agent.tokenId.toString()}>
                        <td>{l.name}</td>
                        <td className="small">{CATEGORY_LABEL[l.category] ?? l.category}</td>
                        <td className="num mono">{l.actionCount}</td>
                        <td className="num mono" style={{ fontWeight: 700, color: l.deltaUsd < 0 ? 'var(--blocked)' : 'var(--ink)' }}>
                          {usd(l.deltaUsd, { sign: true })}
                        </td>
                        <td>
                          <Link href={agentHref(l.agent.chain, l.agent.tokenId)} className="small">Report →</Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <p className="small">
              Every figure above is <strong className="ink">simulated</strong>, against a do-nothing baseline over the
              window named. Same position, same window, every agent in parallel - a controlled comparison, not a
              post-hoc delta. Computed {report.computedAt.toISOString().slice(0, 10)}.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}
