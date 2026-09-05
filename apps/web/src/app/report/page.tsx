import Link from 'next/link';
import { formatBaseUnits, looksLikeTestRegistration, type LivePosition } from '@bench/core';
import { data, isLiveData } from '@/lib/data/index';
import { requestReport } from '@/lib/report/actions';
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
  const queued = result?.status === 'queued' ? result : null;
  const cannotRun = result?.status === 'cannot-run' ? result : null;
  // The position is read from chain in every case that has one; what differs is
  // whether anything has been auditioned against it yet.
  const position =
    result !== null && 'position' in result ? result.position : (report?.position ?? null);
  // A failed report is still a runnable position, so both states offer the run.
  const retry = cannotRun !== null;
  const canRun = result?.status === 'position-only' || retry;

  /**
   * The table a reader is meant to act on, ranked.
   *
   * Two things happen here and neither is a judgement about an agent's
   * numbers. Scaffolding is dropped - registrations that call themselves a
   * demo, a test or a starter, or still carry a builder tool's default name -
   * because the first report opened with `studio-agent` four times over and
   * four `(demo)` entries, and an agent a reader might actually hire was below
   * the fold. They are still indexed, probed, auditioned and counted in every
   * registry figure; this is a presentation rule for one page.
   *
   * Then the sort gets a tie-break. Delta has always been the ranking, but
   * every delta in the first real report was $0.00, and a table of identical
   * zeros fell back to whatever order the catalog returned - which reads as a
   * ranking and is not one. Action count breaks the tie, because an agent that
   * traded and came out level is a different finding from one that did
   * nothing, and name breaks that, so the order is stable across reloads
   * rather than dependent on row order in a query.
   */
  const listed =
    report === null
      ? []
      : [...report.lines]
          .filter((l) => !looksLikeTestRegistration(l.name))
          .sort(
            (a, b) =>
              b.deltaUsd - a.deltaUsd ||
              b.actionCount - a.actionCount ||
              a.name.localeCompare(b.name),
          );
  const excluded = report === null ? 0 : report.lines.length - listed.length;

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '46rem' }}>
          <span className="eyebrow">No wallet · no signature</span>
          <h1 className="h2">What would an agent have done with your position?</h1>
          <p className="lead">Paste a BSC address. The report is a link you can share.</p>
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

        {position !== null ? (
          <PositionPanel position={position} awaitingRequest={result?.status === 'position-only'} />
        ) : null}

        {queued !== null ? (
          // Refreshes itself: the work happens in the worker, and a reader
          // watching a page should not have to know that.
          <div className="card stack stack-8">
            <meta httpEquiv="refresh" content="15" />
            <p className="quote">Auditioning agents against this position.</p>
            <p className="body">
              Requested {queued.requestedAt.toISOString().slice(11, 19)} UTC. This page refreshes
              itself.
            </p>
          </div>
        ) : null}

        {cannotRun !== null ? (
          <div className="card stack stack-8">
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>
              This position could not be auditioned.
            </p>
            <p className="body">{cannotRun.reason}</p>
          </div>
        ) : null}

        {/* The action that turns a position into a measurement. Everything
            above this point is a reading; below it, agents actually run.

            Offered after a failure as well as before a first run. It used to
            render only for `position-only`, so a reader whose report came back
            unauditioned was left on a dead end: the one thing they would want
            to do next - try again, once the catalog has agents that can be
            driven - had no control on the page, and re-requesting means
            editing the URL back to a state the page no longer shows. Nothing
            about a failed audition makes the position less runnable. */}
        {position !== null && canRun ? (
          <form action={requestReport} className="card stack stack-12">
            <input type="hidden" name="address" value={address ?? ''} />
            <h2 className="h3">
              {retry
                ? 'Try this position again'
                : 'Audition every live agent against this position'}
            </h2>
            <p className="body">
              Your balances are mirrored onto a forked chain and handed to every verified-live
              agent, one fork each. Nothing is broadcast; the real position is untouched.
            </p>
            <div>
              <button className="btn btn-primary" type="submit">
                {retry ? 'Run it again' : 'Run the audition'}
              </button>
            </div>
          </form>
        ) : null}

        {!address ? (
          <div className="card stack stack-12">
            <h2 className="h3">Try it on a live position</h2>
            <p className="body">
              {isLiveData
                ? 'Balances come from the token contracts, prices from Chainlink on chain. Then every verified-live agent is auditioned against a mirror of that position.'
                : 'This deployment reads fixtures, so any well-formed address returns a sample position.'}
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
                    {listed.length}
                  </span>
                  {excluded > 0 ? (
                    <span className="tiny">{excluded} more auditioned, listed on the catalog</span>
                  ) : null}
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
                  {listed.map((l) => (
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

            {/* Not "simulated". Both words are true of these numbers and only
                one of them is useful - the same argument BasisBadge makes, and
                this page was still saying the other thing in bold. Every agent
                here is a real third party driven at its own endpoint, and the
                figures come out of the EVM executing its transactions against
                real market state. Nothing is modelled. What did not happen is
                the broadcast. */}
            <p className="small">
              Every figure above is <strong className="ink">measured, not estimated</strong>. Each
              agent was driven at its own endpoint against a fork of BNB Smart Chain pinned to a
              real block, holding a mirror of this position at real prices, and its transactions
              were executed by the EVM against that fork rather than broadcast. Same position, same
              window, every agent in parallel plus a do-nothing baseline - a controlled comparison,
              not a post-hoc delta. Ranked by that delta, then by how much the agent did to earn it.
              Computed {report.computedAt.toISOString().slice(0, 10)}.
            </p>
            {excluded > 0 ? (
              // A filter on a measurement page is stated, or it is not honest.
              <p className="small">
                {excluded} further {excluded === 1 ? 'registration was' : 'registrations were'}{' '}
                auditioned against this position and are not listed above: they name themselves a
                demo, a test or a starter, or still carry the default name their builder tool
                generated. They remain indexed, probed and counted in every figure on{' '}
                <Link href="/registry">registry health</Link>, and the{' '}
                <Link href="/agents">catalog</Link> lists them. Nothing here is hidden for scoring
                badly.
              </p>
            ) : null}
            <p className="small">
              What a fork cannot reproduce is the market reacting: no competing flow, no MEV, and
              nobody else moving the price while the agent works. These are the outcomes the agent
              produced against the book as it stood, which is the closest measurement of a
              counterfactual anyone can take without spending your money to find out.
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
  awaitingRequest,
}: {
  readonly position: LivePosition;
  /**
   * True only where nothing has been asked for yet.
   *
   * This was `auditioned`, and the explainer below rendered on `!auditioned` -
   * which is also true when a request ran and was refused, so the "nobody has
   * auditioned this" text sat directly above the card saying why this position
   * could not be run, and the page argued with itself.
   */
  readonly awaitingRequest: boolean;
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
            Balances read at block <span className="mono">{position.blockNumber.toString()}</span>;
            prices from Chainlink on BSC. LP positions are listed by pair and range rather than
            valued - a confident wrong number is worse than an honest omission.
          </p>
        </>
      )}

      {/* Shown only where there is genuinely nothing yet. This block used to
          render whenever a report was absent, and said the shadow engine
          "needs an archive node and a worker process, neither of which runs
          inside a web request" - true when it was written, and false since the
          audition became something a reader can ask for. It sat directly above
          the card explaining why this particular position was refused, so the
          page contradicted itself. */}
      {awaitingRequest ? (
        <div className="card stack stack-8">
          <p className="quote">No agent has been auditioned against this position yet.</p>
          <p className="body">
            There is no record to look up - the agent never managed this position. Running the
            audition above is what creates one. The <Link href="/agents">catalog</Link> shows what
            each agent has already been auditioned on.
          </p>
        </div>
      ) : null}
    </div>
  );
}
