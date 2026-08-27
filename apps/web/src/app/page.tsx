import Link from 'next/link';
import { liveShareBps } from '@bench/core';
import { data } from '@/lib/data/index';
import { pct } from '@/lib/format';

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


const CHAINS = ['BNB Smart Chain', 'PancakeSwap', 'Venus', 'ERC-8004', 'ERC-8183', 'Binance x402', 'Altana', '8004scan'];

const STEPS = [
  {
    n: '01',
    h: 'Every listed agent runs in shadow',
    p: 'A forked BSC node, pinned at a block, seeded with a mirror of a real position. The agent gets an RPC endpoint and a throwaway key. It believes it is live.',
  },
  {
    n: '02',
    h: 'Its transactions are intercepted, never broadcast',
    p: 'Each one is simulated against fork state and recorded with the intent it expressed and the state it would have produced. No funds move. Nothing reaches the chain.',
  },
  {
    n: '03',
    h: 'Ranked against doing nothing, and against its peers',
    p: 'Same position, same window, every agent in parallel plus a do-nothing baseline. That is a controlled comparison, not a post-hoc delta over a handful of settled jobs.',
  },
];

export default async function Home() {
  const stats = await data.catalogStats();
  const live = liveShareBps(stats);

  return (
    <>
      {/* ---------- hero ---------- */}
      <section className="wrap section">
        <div className="stack stack-24" style={{ maxWidth: '54rem' }}>
          <span className="eyebrow">Agents audition before they are hired</span>

          <h1 className="hero-title">
            Hire agents that have <mark className="mark">already worked</mark> your position.
          </h1>

          <p className="lead" style={{ maxWidth: '40rem' }}>
            The agent registries on BNB Smart Chain are mostly dead listings and bought reviews. Bench ignores both.
            It runs every listed agent against replayed history and against a real position, with no funds at risk,
            and ranks on what the agent <em>would have done</em>.
          </p>

          <div className="row" style={{ gap: '1rem' }}>
            <Link href="/agents" className="btn btn-primary">Browse the catalog</Link>
            <Link href="/report" className="btn btn-ghost">Read your position’s report →</Link>
          </div>

          <p className="small">No wallet needed. Paste any BSC address.</p>
        </div>
      </section>

      {/* ---------- measured, not asserted ---------- */}
      <section className="wrap section-tight">
        <div className="statgrid">
          <div className="statcell">
            <div className="statnum">{stats.registered}</div>
            <div className="statlabel">Agents registered on BSC</div>
          </div>
          <div className="statcell">
            <div className="statnum">{stats.withResolvableCard}</div>
            <div className="statlabel">With a resolvable agent card</div>
          </div>
          <div className="statcell">
            <div className="statnum">{stats.verifiedLive}</div>
            <div className="statlabel">Verified live - respond and conform</div>
          </div>
          <div className="statcell">
            <div className="statnum">{pct(live)}</div>
            <div className="statlabel">
              <Link href="/registry" style={{ color: 'inherit' }}>Of the registry is real →</Link>
            </div>
          </div>
        </div>
        <p className="tiny" style={{ marginTop: '0.85rem' }}>
          Bench’s own measurement, recomputed daily against what it has indexed - not a figure quoted from a paper.
        </p>
      </section>

      {/* ---------- the problem ---------- */}
      <section className="wrap section">
        <div className="slab on-dark stack stack-32">
          <span className="eyebrow">The problem</span>
          <h2 className="h2" style={{ maxWidth: '30rem' }}>
            A marketplace that sorts by star rating ships a directory of dead agents ranked by noise.
          </h2>

          <div className="grid grid-3">
            {[
              ['~4%', 'of registered agents on BSC have a live service endpoint'],
              ['~59%', 'of reviewers show coordinated Sybil behaviour'],
              ['~78%', 'of rated agents have no valid feedback once those are removed'],
            ].map(([n, t]) => (
              <div key={n} className="stack stack-8">
                <div style={{ fontSize: 'clamp(2.2rem, 6vw, 3rem)', fontWeight: 700, letterSpacing: '-0.04em' }}>{n}</div>
                <p className="small">{t}</p>
              </div>
            ))}
          </div>

          <hr className="rule" />
          <p className="small">
            Measured across the live ERC-8004 ecosystem through May 2026 -{' '}
            <a href="https://arxiv.org/abs/2606.26028" style={{ color: 'inherit' }}>arXiv 2606.26028</a>. Reputation
            values are not comparable across agents, feedback rarely links to a verifiable transaction, and
            manipulation costs almost nothing.
          </p>
        </div>
      </section>

      {/* ---------- mechanism ---------- */}
      <section className="wrap section">
        <div className="stack stack-48">
          <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
            <span className="eyebrow">The mechanism</span>
            <h2 className="h2">Auditions cost compute, not users.</h2>
            <p className="lead">
              Which means a dense, honest track record on day one with zero paying customers - and a controlled
              comparison rather than a noisy delta over a handful of settled jobs.
            </p>
          </div>

          <div className="grid grid-3">
            {STEPS.map((s) => (
              <div key={s.n} className="card stack stack-12">
                <span className="mono small">{s.n}</span>
                <h3 className="h4">{s.h}</h3>
                <p className="body">{s.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---------- the absences ---------- */}
      <section className="wrap section">
        <div className="stack stack-32">
          <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
            <span className="eyebrow">What Bench refuses to do</span>
            <h2 className="h2">The same measurement that produces the ranking produces the constraint.</h2>
          </div>

          <div className="stack stack-16">
            {[
              ['Bench cannot list an agent that has never worked.', 'Every listing carries an audition record or is shown, explicitly, as having none. There is no third state.'],
              ['You cannot hire on a claim or a review.', 'Only on what the agent already did to a position shaped like yours, against a do-nothing baseline, over a window we name.'],
              ['A hired agent cannot exceed your cap - or do anything it did not do in audition.', 'Every transaction is simulated and checked against the envelope it established while auditioning, before the session key will sign it.'],
            ].map(([h, p]) => (
              <div key={h} className="card stack stack-8">
                <p className="quote">{h}</p>
                <p className="body">{p}</p>
              </div>
            ))}
          </div>

          <p className="small">
            A spend cap answers <em>how much</em>. The gate answers <em>what kind of thing</em> - and it is derived
            from measured evidence rather than guessed at in a checkout form.
          </p>
        </div>
      </section>

      {/* ---------- chain strip ---------- */}
      <section className="wrap section-tight">
        <div className="strip">
          {CHAINS.map((c) => (
            <span key={c} className="chip">{c}</span>
          ))}
        </div>
        <p className="small" style={{ textAlign: 'center', marginTop: '1.25rem' }}>
          Built on BNB Smart Chain, on the registries and rails the ecosystem already ships.
        </p>
      </section>

      {/* ---------- cta ---------- */}
      <section className="wrap section">
        <div className="slab on-dark stack stack-24" style={{ textAlign: 'center', alignItems: 'center' }}>
          <h2 className="h2" style={{ maxWidth: '26rem' }}>
            See what an agent would have done with your money.
          </h2>
          <p className="lead" style={{ maxWidth: '32rem' }}>
            Paste a BSC address. No connection, no signature, no listing fee - the position is public and the
            audition is a simulation.
          </p>
          <Link href="/report" className="btn btn-primary">Read the report</Link>
        </div>
      </section>
    </>
  );
}
