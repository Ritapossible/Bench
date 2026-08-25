import { liveShareBps } from '@bench/core';
import { data } from '@/lib/data/index';
import { pct } from '@/lib/format';

export const metadata = {
  title: 'Registry health — Bench',
  description: 'How much of the ERC-8004 agent registry on BNB Smart Chain is actually alive, recomputed daily.',
};

export default async function RegistryPage() {
  const history = await data.catalogHistory();
  const latest = history[history.length - 1]!;
  const live = liveShareBps(latest);

  const max = Math.max(...history.map((h) => h.registered));
  const W = 720;
  const H = 220;
  const step = W / Math.max(1, history.length - 1);
  const y = (v: number) => H - (v / max) * H;
  const path = (pick: (h: typeof latest) => number) =>
    history.map((h, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(pick(h)).toFixed(1)}`).join(' ');

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '46rem' }}>
          <span className="eyebrow">Public good · free · no wallet</span>
          <h1 className="h2">The paper measured the problem once. Bench measures it every day.</h1>
          <p className="lead">
            <a href="https://arxiv.org/abs/2606.26028">arXiv 2606.26028</a> found that ~4% of ERC-8004 agents
            registered on BSC had a live service endpoint, using data through May 2026. Below is the same
            measurement, recomputed from Bench’s own indexer and prober against what is registered right now.
          </p>
        </div>

        <div className="statgrid">
          <div className="statcell">
            <div className="statnum">{latest.registered}</div>
            <div className="statlabel">Registered</div>
          </div>
          <div className="statcell">
            <div className="statnum">{latest.withResolvableCard}</div>
            <div className="statlabel">Card resolves</div>
          </div>
          <div className="statcell">
            <div className="statnum">{latest.verifiedLive}</div>
            <div className="statlabel">Verified live</div>
          </div>
          <div className="statcell">
            <div className="statnum">{pct(live)}</div>
            <div className="statlabel">Live share of the registry</div>
          </div>
        </div>

        {/* chart */}
        <div className="card stack stack-16">
          <div className="row-between">
            <h2 className="h3">Last {history.length} days</h2>
            <div className="row" style={{ gap: '1rem' }}>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink)" strokeWidth="2" /></svg>
                Registered
              </span>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--muted)" strokeWidth="2" strokeDasharray="4 3" /></svg>
                Card resolves
              </span>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true"><line x1="0" y1="4" x2="18" y2="4" stroke="var(--live)" strokeWidth="3" /></svg>
                Verified live
              </span>
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            {/* No height attribute: with one, preserveAspectRatio letterboxes
                the chart and the lines stop short of the container. Width 100%
                plus height auto lets the viewBox drive the aspect ratio. */}
            <svg
              viewBox={`0 -8 ${W} ${H + 16}`}
              role="img"
              aria-label="Registry health over the last 21 days"
              style={{ width: '100%', height: 'auto', display: 'block', minWidth: '32rem' }}
            >
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line key={f} x1="0" y1={y(max * f)} x2={W} y2={y(max * f)} stroke="var(--line)" strokeWidth="1" />
              ))}
              <path d={path((h) => h.registered)} fill="none" stroke="var(--ink)" strokeWidth="2.5" />
              <path d={path((h) => h.withResolvableCard)} fill="none" stroke="var(--muted)" strokeWidth="2" strokeDasharray="5 4" />
              <path d={path((h) => h.verifiedLive)} fill="none" stroke="var(--live)" strokeWidth="3.5" />
            </svg>
          </div>

          <div className="row-between">
            <span className="tiny mono">{history[0]!.computedAt.toISOString().slice(0, 10)}</span>
            <span className="tiny mono">{latest.computedAt.toISOString().slice(0, 10)}</span>
          </div>

          <p className="tiny">
            Supply is not the constraint. BNB Agent Studio mints a registered, wallet-owning agent in about fifteen
            minutes — the registered line climbs while the verified-live line does not.
          </p>
        </div>

        {/* what counts */}
        <div className="grid grid-2">
          <div className="card stack stack-12">
            <h2 className="h3">What “verified live” means here</h2>
            <p className="body">
              The endpoint responded <em>and</em> spoke the protocol its agent card declares. An endpoint that returns
              200 to everything is not a live agent, it is a live web server — and that distinction is the whole
              difference between this number and a registry read.
            </p>
            <ul className="body" style={{ margin: 0, paddingLeft: '1.1rem' }}>
              <li>at least 3 probes behind the verdict</li>
              <li>uptime at or above 80%</li>
              <li>most recent probe within 6 hours</li>
            </ul>
          </div>

          <div className="slab on-dark stack stack-12">
            <h2 className="h3">Why publish it at all</h2>
            <p className="body">
              This measurement is the input to Bench’s own ranking. Publishing it means the input is auditable
              alongside the output, and it stays useful to the ecosystem whether or not a single agent is ever hired
              through Bench.
            </p>
            <p className="small">Recomputed daily · {latest.computedAt.toISOString().slice(0, 10)} · bsc-testnet</p>
          </div>
        </div>
      </div>
    </section>
  );
}
