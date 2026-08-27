import Link from 'next/link';
import { formatBaseUnits, type LivePosition } from '@bench/core';
import { data, isLiveData } from '@/lib/data/index';
import { CATEGORY_LABEL, usd, agentHref } from '@/lib/format';

export const metadata = {
  title: 'Your position’s report - Bench',
  description:
    'Paste any BSC address and see what each agent would have done with that position. No wallet needed.',
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
  const unavailable = result?.status === 'unavailable' ? result.reason : null;
  // The position is read from chain in both the 'ok' and 'position-only' cases;
  // what differs is whether anything has been auditioned against it.
  const position =
    result?.status === 'position-only' ? result.position : (report?.position ?? null);
  const auditioned = result?.status === 'ok';

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '46rem' }}>
          <span className="eyebrow">No wallet · no signature</span>
          <h1 className="h2">What would an agent have done with your position?</h1>
          <p className="lead">
            The position is public state and the audition is a simulation, so nothing here needs you
            to connect anything. Paste an address - the resulting report is a link you can share.
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
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>
              That does not look like a BSC address.
            </p>
            <p className="body">
              Expected 40 hex characters after <span className="mono">0x</span>. Try the example:{' '}
              <Link href={`/report?address=${EXAMPLE}`} className="mono break">
                {EXAMPLE}
              </Link>
            </p>
          </div>
        ) : null}

        {unavailable !== null ? (
          <div className="card stack stack-8">
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>
              Could not read this address from a BSC node.
            </p>
            <p className="body small mono break">{unavailable}</p>
            <p className="body">
              Nothing is wrong with the address - Bench could not reach the chain. Try again in a
              moment.
            </p>
          </div>
        ) : null}

        {position !== null ? <PositionPanel position={position} auditioned={auditioned} /> : null}

        {!address ? (
          <div className="card stack stack-12">
            <h2 className="h3">Try it on a live position</h2>
            <p className="body">
              {isLiveData
                ? 'Your position is read straight from BSC - balances from the token contracts, prices from Chainlink on chain. The agent comparison replays that position through every verified-live agent on a fork, which needs the shadow engine running; until it is, the report shows the position alone.'
                : 'This deployment reads testnet fixtures while the shadow engine is being built, so any well-formed address returns a sample PancakeSwap LP position.'}
            </p>
            <div>
              <Link
                href={`/report?address=${EXAMPLE}`}
                className="btn btn-outline btn-sm mono break"
                style={{ maxWidth: '100%' }}
              >
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
                  <span
                    className="mono"
                    style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
                  >
                    {usd(report.positionValueUsd)}
                  </span>
                </div>
                <div className="stack stack-4">
                  <span className="tiny">Window</span>
                  <span
                    className="mono"
                    style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
                  >
                    {report.windowLabel}
                  </span>
                </div>
                <div className="stack stack-4">
                  <span className="tiny">Agents auditioned</span>
                  <span
                    className="mono"
                    style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
                  >
                    {report.lines.length}
                  </span>
                </div>
              </div>
              <p className="small mono break">{report.address}</p>
            </div>

            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Category</th>
                    <th className="num">Actions</th>
                    <th className="num">vs doing nothing</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <strong>Do nothing</strong>
                    </td>
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
                        <td
                          className="num mono"
                          style={{
                            fontWeight: 700,
                            color: l.deltaUsd < 0 ? 'var(--blocked)' : 'var(--ink)',
                          }}
                        >
                          {usd(l.deltaUsd, { sign: true })}
                        </td>
                        <td>
                          <Link href={agentHref(l.agent.chain, l.agent.tokenId)} className="small">
                            Report →
                          </Link>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>

            <p className="small">
              Every figure above is <strong className="ink">simulated</strong>, against a do-nothing
              baseline over the window named. Same position, same window, every agent in parallel -
              a controlled comparison, not a post-hoc delta. Computed{' '}
              {report.computedAt.toISOString().slice(0, 10)}.
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * What the address actually holds.
 *
 * Labelled "read from chain" rather than left to blend into the rest of the
 * page, because this panel and the comparison table below it are different
 * kinds of claim: these are balances anyone can verify at the block named, and
 * those are a counterfactual produced by replaying history. A reader who cannot
 * tell them apart will read the weaker claim with the strength of the stronger.
 */
function PositionPanel({
  position,
  auditioned,
}: {
  readonly position: LivePosition;
  readonly auditioned: boolean;
}) {
  const empty = position.holdings.length === 0 && position.lpPositions.length === 0;

  return (
    <div className="stack stack-16">
      <div className="slab on-dark stack stack-12">
        <span className="eyebrow">Read from chain · block {position.blockNumber.toString()}</span>
        <h2 className="h3">
          {empty ? 'This address holds nothing we track' : 'What this address holds'}
        </h2>
        {empty ? null : (
          <div className="row" style={{ gap: '1.5rem 2.5rem' }}>
            <div className="stack stack-4">
              <span className="tiny">{position.partiallyValued ? 'Valued at least' : 'Value'}</span>
              <span
                className="mono"
                style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
              >
                {usd(position.valuedUsd)}
              </span>
            </div>
            <div className="stack stack-4">
              <span className="tiny">Assets</span>
              <span
                className="mono"
                style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
              >
                {position.holdings.length}
              </span>
            </div>
            {position.lpPositions.length > 0 ? (
              <div className="stack stack-4">
                <span className="tiny">LP positions</span>
                <span
                  className="mono"
                  style={{ fontSize: 'clamp(1.15rem, 5vw, 1.5rem)', fontWeight: 700 }}
                >
                  {position.lpPositions.length}
                </span>
              </div>
            ) : null}
          </div>
        )}
        <p className="small mono break">{position.address}</p>
      </div>

      {empty ? (
        <p className="small">
          Read at block {position.blockNumber.toString()} on BSC mainnet. Balances are checked for
          BNB and the six assets Bench&rsquo;s agents trade, so an address holding something else
          shows as empty here.
        </p>
      ) : (
        <>
          <div className="tablewrap">
            <table className="t">
              <thead>
                <tr>
                  <th>Asset</th>
                  <th className="num">Amount</th>
                  <th className="num">Value</th>
                </tr>
              </thead>
              <tbody>
                {position.holdings.map((h) => (
                  <tr key={h.token}>
                    <td>
                      <strong>{h.symbol}</strong>
                    </td>
                    <td className="num mono">{formatBaseUnits(h.amount, h.decimals, 4)}</td>
                    <td className="num mono">
                      {h.usdValue === null ? (
                        <span className="small">no price feed</span>
                      ) : (
                        usd(h.usdValue)
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {position.lpPositions.length > 0 ? (
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>PancakeSwap v3 position</th>
                    <th className="num">Fee</th>
                    <th className="num">Range</th>
                  </tr>
                </thead>
                <tbody>
                  {position.lpPositions.map((lp) => (
                    <tr key={lp.tokenId.toString()}>
                      <td>
                        <strong>
                          {lp.symbol0}/{lp.symbol1}
                        </strong>{' '}
                        <span className="small mono">#{lp.tokenId.toString()}</span>
                      </td>
                      <td className="num mono">{(lp.feeBps / 100).toFixed(2)}%</td>
                      <td className="num mono small">
                        {lp.tickLower} to {lp.tickUpper}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <p className="small">
            Balances read from the token contracts at block{' '}
            <span className="mono">{position.blockNumber.toString()}</span>; prices from Chainlink
            aggregators on BSC itself, not an off-chain quote. Every figure above is a fact you can
            check against the chain. Liquidity positions are listed by pair and range rather than
            valued, because valuing one means reconstructing amounts from the pool&rsquo;s tick and
            a confident wrong number is worse than an honest omission.
          </p>
        </>
      )}

      {auditioned ? null : (
        <div className="card stack stack-8">
          <p className="quote">No agent has been auditioned against this position yet.</p>
          <p className="body">
            That half is not a lookup. &ldquo;What would this agent have done with your
            position?&rdquo; asks about something that did not happen - the agent never managed it,
            so there is no record of it anywhere to read. The only way to answer is to fork BSC at a
            past block, mirror this position into it, and let the real agent trade against real
            history. That is the shadow engine, and it needs an archive node and a worker process,
            neither of which runs inside a web request.
          </p>
          <p className="body">
            Until then: the <Link href="/agents">catalog</Link> shows what each agent has already
            been auditioned on, against the same positions and windows for every agent.
          </p>
        </div>
      )}
    </div>
  );
}
