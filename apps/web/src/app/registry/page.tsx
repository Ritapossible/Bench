import Link from 'next/link';
import { liveShareBps } from '@bench/core';
import { data, isLiveData } from '@/lib/data/index';
import { pct } from '@/lib/format';

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

export const metadata = {
  title: 'Registry health - Bench',
  description:
    'How much of the ERC-8004 agent registry on BNB Smart Chain is actually alive, recomputed daily.',
};

export default async function RegistryPage() {
  const [latest, history, agreement, provenance] = await Promise.all([
    // The headline is a live count, not the newest history row. History is
    // written on a throttle, so reading the headline from it showed an
    // hour-old number as current - and after a run that appended rows for a
    // different catalog, showed that catalog's numbers instead.
    data.catalogStats(),
    data.catalogHistory(),
    data.crossReference(),
    data.catalogProvenance(),
  ]);
  const indexed = provenance === 'indexed';
  const live = liveShareBps(latest);

  // The chart ends at the same measurement the headline states, so the two can
  // never disagree on screen.
  const series = [...history.filter((h) => h.computedAt < latest.computedAt), latest];
  const max = Math.max(...series.map((h) => h.registered));
  const W = 720;
  const H = 220;
  const step = W / Math.max(1, series.length - 1);
  const y = (v: number) => H - (v / max) * H;
  const path = (pick: (h: typeof latest) => number) =>
    history
      .map((h, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(pick(h)).toFixed(1)}`)
      .join(' ');

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '46rem' }}>
          <span className="eyebrow">Public good · free · no wallet</span>
          <h1 className="h2">The paper measured the problem once. Bench measures it every day.</h1>
          {isLiveData ? null : (
            <p className="notice notice-warn" role="status">
              This deployment has no database configured, so these figures are fixtures, not indexed
              data.
            </p>
          )}
          <p className="lead">
            <a href="https://arxiv.org/abs/2606.26028">arXiv 2606.26028</a> found that ~4% of
            ERC-8004 agents registered on BSC had a live service endpoint, using data through May
            2026.{' '}
            {indexed
              ? 'Below is the same measurement, recomputed from Bench’s own indexer and prober against what is registered right now.'
              : 'The same measurement runs below, from Bench’s own prober - but against a demo catalog rather than the live registry, so the figures describe this deployment and not the state of BSC.'}
          </p>
        </div>

        {/*
          Said plainly, next to the numbers it qualifies, rather than in a
          footnote. This page exists to contrast its figures with the paper's
          ~4%, and that contrast is only a finding if the figures came off
          chain. A curated catalog reports a live share in the high seventies,
          which read against the paper looks like a spectacular discovery and
          is in fact a demo. Overclaiming here would be the same failure this
          page was built to document.
        */}
        {indexed ? null : (
          <div className="card stack stack-8">
            <p className="quote" style={{ borderColor: 'var(--blocked)' }}>
              These numbers describe a {provenance === 'fixtures' ? 'fixture' : 'seeded'} catalog,
              not the BSC registry.
            </p>
            <p className="body">
              The indexer has not run against a registry on this deployment, so the live share below
              is a property of the demo catalog and is not comparable to the paper&rsquo;s 4%. It
              starts measuring the real registry the moment the indexer is pointed at one.
            </p>
          </div>
        )}

        <p className="small">
          The measurement below is only as current as the machinery producing it -{' '}
          <Link href="/status">what the indexer, prober and audition queues are doing</Link> is on
          its own page, including any queue that is completing without doing work.
        </p>

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
            <h2 className="h3">{series.length === 1 ? 'Today' : `Last ${series.length} days`}</h2>
            <div className="row" style={{ gap: '1rem' }}>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="18" y2="4" stroke="var(--ink)" strokeWidth="2" />
                </svg>
                Registered
              </span>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true">
                  <line
                    x1="0"
                    y1="4"
                    x2="18"
                    y2="4"
                    stroke="var(--muted)"
                    strokeWidth="2"
                    strokeDasharray="4 3"
                  />
                </svg>
                Card resolves
              </span>
              <span className="row tiny" style={{ gap: '0.4rem' }}>
                <svg width="18" height="8" aria-hidden="true">
                  <line x1="0" y1="4" x2="18" y2="4" stroke="var(--live)" strokeWidth="3" />
                </svg>
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
              aria-label={`Registry health over the last ${series.length} ${series.length === 1 ? 'day' : 'days'}`}
              style={{ width: '100%', height: 'auto', display: 'block', minWidth: '32rem' }}
            >
              {[0.25, 0.5, 0.75, 1].map((f) => (
                <line
                  key={f}
                  x1="0"
                  y1={y(max * f)}
                  x2={W}
                  y2={y(max * f)}
                  stroke="var(--line)"
                  strokeWidth="1"
                />
              ))}
              <path
                d={path((h) => h.registered)}
                fill="none"
                stroke="var(--ink)"
                strokeWidth="2.5"
              />
              <path
                d={path((h) => h.withResolvableCard)}
                fill="none"
                stroke="var(--muted)"
                strokeWidth="2"
                strokeDasharray="5 4"
              />
              <path
                d={path((h) => h.verifiedLive)}
                fill="none"
                stroke="var(--live)"
                strokeWidth="3.5"
              />
            </svg>
          </div>

          <div className="row-between">
            <span className="tiny mono">{series[0]!.computedAt.toISOString().slice(0, 10)}</span>
            <span className="tiny mono">{latest.computedAt.toISOString().slice(0, 10)}</span>
          </div>

          <p className="tiny">
            Supply is not the constraint. BNB Agent Studio mints a registered, wallet-owning agent
            in about fifteen minutes - the registered line climbs while the verified-live line does
            not.
          </p>
        </div>

        {/* corroboration */}
        <div className="card stack stack-12">
          <div className="row-between">
            <h2 className="h3">Corroboration</h2>
            {agreement.status === 'ok' ? (
              <span className="badge badge-live">
                <span className="dot" />
                {pct(agreement.agreementBps)} agreement
              </span>
            ) : (
              <span className="badge badge-plain">
                {agreement.status === 'unconfigured' ? 'Not yet configured' : 'Source unavailable'}
              </span>
            )}
          </div>

          {agreement.status === 'ok' ? (
            <p className="body">
              Of the <strong className="ink">{agreement.checked}</strong> agents Bench indexed from
              chain, <a href="https://8004scan.io">8004scan</a> also sees{' '}
              <strong className="ink">{agreement.confirmed}</strong>. The{' '}
              <strong className="ink">{agreement.notFound}</strong> it does not are the interesting
              ones.
            </p>
          ) : (
            <p className="body">
              Bench reads the registry from chain directly, and cross-checks that against{' '}
              <a href="https://8004scan.io">AltLayer&rsquo;s 8004scan</a> - an independent explorer
              - so the figures above are corroborated rather than merely asserted.{' '}
              {agreement.status === 'unconfigured'
                ? 'An API key has been requested and is not yet in place, so nothing has been cross-checked yet.'
                : 'The source did not answer usably on the last run.'}
            </p>
          )}

          <p className="tiny">
            One-directional by construction: looking agents up by the ids Bench already holds
            measures corroboration, not coverage. It can never find agents 8004scan knows and Bench
            does not, and it is labelled that way rather than presented as a completeness figure.
            The chain remains the source of truth - this never gates the catalog.
          </p>
        </div>

        {/* what counts */}
        <div className="grid grid-2">
          <div className="card stack stack-12">
            <h2 className="h3">What “verified live” means here</h2>
            <p className="body">
              The endpoint responded <em>and</em> spoke the protocol its agent card declares. An
              endpoint that returns 200 to everything is not a live agent, it is a live web server -
              and that distinction is the whole difference between this number and a registry read.
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
              This measurement is the input to Bench’s own ranking. Publishing it means the input is
              auditable alongside the output, and it stays useful to the ecosystem whether or not a
              single agent is ever hired through Bench.
            </p>
            <p className="small">
              Recomputed daily · {latest.computedAt.toISOString().slice(0, 10)} · bsc-testnet
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
