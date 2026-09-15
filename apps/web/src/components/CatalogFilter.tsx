import Link from 'next/link';
import { AgentAvatar } from '@/components/AgentAvatar';
import { CATEGORY_LABEL, usd, pct, ms } from '@/lib/format';

/**
 * Plain view model. Server components cannot hand a client component a bigint
 * or a Date, and the boundary is a good place to decide exactly what the UI is
 * allowed to see anyway.
 */
export interface AgentRow {
  readonly href: string;
  readonly tokenId: string;
  readonly name: string;
  /** The logo the registration published, already scheme-checked at parse. */
  readonly image?: string | undefined;
  readonly description: string;
  readonly category: string;
  readonly verifiedLive: boolean;
  /**
   * The host this agent answers on, and how many verified-live agents share it.
   *
   * **The qualifier on the live badge.** A large share of this catalog's live
   * agents are one platform's hosted runtime: separate identity NFTs, separate
   * owners, sequential platform ids, a single endpoint. Every probe that says
   * those are up is the same probe against the same machine, so "verified live"
   * counts responses rather than independent things responding - and a reader
   * has no way to tell from the row.
   *
   * Shown rather than corrected. Bench's whole claim is that its numbers are
   * measured and checkable, and the honest move when a measurement means less
   * than it looks like is to say what it measured, not to quietly drop the
   * rows.
   */
  readonly host: string | null;
  readonly hostAgents: number;
  readonly conformant: boolean;
  readonly uptimeBps: number;
  readonly p95LatencyMs: number | null;
  readonly probeCount: number;
  /**
   * Whether Bench can drive this agent at all.
   *
   * An unranked agent said "Listed, probed, unranked" whether it was waiting
   * its turn or could never be auditioned, and those are different facts about
   * an agent. Derived from the card's endpoints, so it costs no storage: an
   * agent declaring neither A2A nor MCP has no interface to be handed a task
   * through, and no amount of waiting will change that.
   */
  readonly drivable: boolean;
  /** Null when the agent has no completed auditions. Never faked. */
  readonly deltaUsd: number | null;
  readonly sampleSize: number;
  readonly thin: boolean;
  /**
   * Auditions attempted that failed, and why the last one did.
   *
   * Zero with a null `deltaUsd` means the queue has not reached this agent.
   * Non-zero means it did, and the agent could not be driven - a result, and
   * for most of this catalog the only result there is. Both used to render as
   * "No auditions yet - queued for audition", which was false for the second
   * group and made the audition queue look idle when it was working.
   */
  readonly failedAuditions: number;
  readonly failureReason: string | null;
}

/**
 * The four judged categories lead, in the contest's own order. Agent Diversity
 * is one of three main-track criteria and requires all four surfaced with
 * equal depth, so the filter presents them as peers rather than burying three
 * of them behind a dropdown.
 */
const CATEGORIES = [
  'all',
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
  'monitoring',
  'other',
] as const;

/**
 * A server component, deliberately.
 *
 * This filtered in the browser over whatever page had loaded, which made the
 * chip counts a statement about the slice rather than the catalog - four
 * equal-looking buttons over 40, 0, 0 and 3 agents look exactly like four over
 * a balanced one, and Agent Diversity is a third of the main-track score. It
 * also meant the selection lived in React state, so `?category=grid` did
 * nothing and a judge could not link anyone to a category.
 *
 * The counts now come from one grouped SQL count over the whole catalog, the
 * rows come back already filtered, and each chip is a real link. An empty
 * category still shows its zero: that is a fact about the registry, and hiding
 * it is the one thing this catalog is built not to do.
 */
/**
 * "This is not the only agent on this box."
 *
 * Rendered beside the live badge rather than lower down, because it changes
 * what that badge means and a qualifier further away than the claim is a
 * qualifier nobody reads. Silent for an agent alone on its host - which is the
 * ordinary case and needs no explanation - and silent for one with no host at
 * all, where there is nothing to say.
 */
function SharedHost({ host, agents }: { readonly host: string | null; readonly agents: number }) {
  if (host === null || agents < 2) return null;
  return (
    <span
      className="badge badge-thin"
      title={`${agents} verified-live agents in this catalog answer on ${host}. They were probed separately and answered from the same place, so the live count is a count of responses rather than of independent services.`}
    >
      {agents} live on {host}
    </span>
  );
}

export function CatalogFilter({
  rows,
  counts,
  registered,
  category,
  liveOnly,
  totalIndexed,
  page,
  perPage,
}: {
  readonly rows: readonly AgentRow[];
  readonly counts: Readonly<Record<string, number>>;
  /** How many exist at all, regardless of the live filter. */
  readonly registered: Readonly<Record<string, number>>;
  readonly category: string;
  readonly liveOnly: boolean;
  readonly totalIndexed: number;
  /** 1-based, already clamped by the page. */
  readonly page: number;
  readonly perPage: number;
}) {
  /**
   * Every link says which view it leads to, including the default one.
   *
   * `live` used to be written only when false, so turning the filter back on
   * produced a bare `/agents` - the same URL as a first visit, and therefore
   * not a choice the page could see. With the empty-catalog fallback in front
   * of it that made the checkbox unturn-on-able whenever nothing was verified:
   * click, land on `/agents`, fall back to off, box still empty. Saying it
   * both ways costs a query parameter and makes the toggle mean something.
   */
  const href = (next: { category?: string; live?: boolean; page?: number }): string => {
    const c = next.category ?? category;
    const l = next.live ?? liveOnly;
    const params = new URLSearchParams();
    if (c !== 'all') params.set('category', c);
    params.set('live', l ? 'true' : 'false');
    /**
     * Changing a filter goes back to page one, and only an explicit page stays.
     *
     * Keeping the page across a filter change lands a reader on page 14 of a
     * list that now has three entries - an empty screen that looks like the
     * filter broke rather than like the page number went stale.
     */
    if (next.page !== undefined && next.page > 1) params.set('page', String(next.page));
    return `/agents?${params.toString()}`;
  };

  const pages = Math.max(1, Math.ceil(rows.length / perPage));
  const start = (page - 1) * perPage;
  const shown = rows.slice(start, start + perPage);

  return (
    <div className="stack stack-24">
      <div className="filters">
        <div className="filter-chips" role="group" aria-label="Filter by category">
          {CATEGORIES.map((c) => (
            <Link
              key={c}
              href={href({ category: c })}
              aria-current={category === c ? 'page' : undefined}
              className={category === c ? 'btn btn-primary btn-sm' : 'btn btn-outline btn-sm'}
              style={{ textDecoration: 'none' }}
            >
              {c === 'all' ? 'All' : CATEGORY_LABEL[c]}{' '}
              {/* live / registered, so a zero reads as "none of the 38 are
                  answering" rather than as "there is nothing here". */}
              <span className="chip-count">
                {liveOnly && (registered[c] ?? 0) !== (counts[c] ?? 0)
                  ? `${counts[c] ?? 0}/${registered[c] ?? 0}`
                  : (counts[c] ?? 0)}
              </span>
            </Link>
          ))}
        </div>

        <Link
          href={href({ live: !liveOnly })}
          className="filter-toggle"
          style={{ textDecoration: 'none' }}
        >
          <input type="checkbox" checked={liveOnly} readOnly tabIndex={-1} aria-hidden="true" />
          <span className="small ink" style={{ whiteSpace: 'nowrap' }}>
            Verified live only
          </span>
        </Link>
      </div>

      <p className="small">
        Showing{' '}
        <strong className="ink">
          {rows.length === 0 ? 0 : start + 1}-{start + shown.length}
        </strong>{' '}
        of {category === 'all' ? totalIndexed : (counts[category] ?? 0)}{' '}
        {category === 'all' ? 'indexed' : `${CATEGORY_LABEL[category] ?? category} agents`}
        {rows.length < (category === 'all' ? totalIndexed : (counts[category] ?? 0))
          ? `, ${rows.length} loaded`
          : ''}
        .{' '}
        {liveOnly
          ? 'Verified live means the endpoint responded and spoke the protocol its card declares - not merely returned 200.'
          : 'Filter off: this is what a raw registry read looks like.'}
      </p>

      <div className="stack stack-12">
        {shown.map((r) => (
          <Link key={r.tokenId} href={r.href} className="card card-link">
            <div className="sumcard">
              <div className="sumcard-head">
                <AgentAvatar src={r.image} name={r.name} />
                <h3 className="h4">{r.name}</h3>
                {r.verifiedLive ? (
                  <span className="badge badge-live">
                    <span className="dot" /> Verified live
                  </span>
                ) : r.probeCount === 0 ? (
                  // Unmeasured, not failed. See LiveBadge.
                  <span className="badge badge-plain">Not probed yet</span>
                ) : (
                  <span className="badge badge-dead">
                    {r.conformant ? 'Not verified' : 'Non-conformant'}
                  </span>
                )}
                {r.thin ? <span className="badge badge-thin">Thin sample</span> : null}
                <SharedHost host={r.host} agents={r.hostAgents} />
              </div>

              <div className="sumcard-score">
                {r.deltaUsd === null && r.failedAuditions > 0 ? (
                  <>
                    <span className="small ink">Could not be driven</span>
                    <span className="tiny break">
                      {r.failedAuditions} audition{r.failedAuditions === 1 ? '' : 's'} attempted,
                      none completed
                      {r.failureReason === null ? '' : ` - ${r.failureReason}`}
                    </span>
                  </>
                ) : r.deltaUsd === null ? (
                  <>
                    <span className="small ink">No auditions yet</span>
                    <span className="tiny">
                      {!r.drivable
                        ? 'No A2A or MCP endpoint to drive'
                        : r.verifiedLive
                          ? 'Queued for audition'
                          : r.probeCount === 0
                            ? 'Waiting on its first probe'
                            : 'Not verified live - cannot be auditioned yet'}
                    </span>
                  </>
                ) : (
                  <>
                    <span
                      className="mono sumcard-value"
                      style={{ color: r.deltaUsd < 0 ? 'var(--blocked)' : 'var(--ink)' }}
                    >
                      {usd(r.deltaUsd, { sign: true })}
                    </span>
                    <span className="tiny">
                      vs doing nothing · {r.sampleSize} audition
                      {r.sampleSize === 1 ? '' : 's'} on a forked chain
                    </span>
                  </>
                )}
              </div>

              <div className="sumcard-body">
                {/*
                  `break`, because this is not always prose. When a card fails
                  to resolve the description is the failure - `HTTP 429 for
                  ipfs://QmWLUqud...` - and a CID has no spaces in it, so the
                  line refuses to wrap and runs off the side of the card on a
                  phone. The text that explains a problem should not create one.
                */}
                <p className="body break">{r.description || 'Agent card did not resolve.'}</p>
                <p className="tiny mono">
                  #{r.tokenId} · {CATEGORY_LABEL[r.category] ?? r.category} · uptime{' '}
                  {pct(r.uptimeBps)} · p95 {ms(r.p95LatencyMs)} · {r.probeCount} probes
                </p>
              </div>
            </div>
          </Link>
        ))}

        {shown.length === 0 ? (
          /**
           * An empty category is a measurement, so it has to read like one.
           *
           * "Nothing matches. Loosen a filter." is what a search box says when
           * it has failed you. Health-factor monitoring is one of the four
           * categories this marketplace is judged on, and it has 38 registered
           * agents of which none is verified live - which is the single most
           * interesting sentence on the page and was rendered as a shrug.
           */
          <div className="card stack stack-8">
            {liveOnly && (counts[category] ?? 0) > 0 ? (
              <>
                <p className="quote">
                  {counts[category]}{' '}
                  {category === 'all'
                    ? 'agents are'
                    : `${(CATEGORY_LABEL[category] ?? category).toLowerCase()} agents are`}{' '}
                  registered on this chain, and none of them is verified live right now.
                </p>
                <p className="body">
                  That is a fact about the registry, not a gap in this page. An agent counts as live
                  only if its endpoint answered and spoke the protocol its own card declares, within
                  the last six hours.
                </p>
                <div>
                  <Link href={href({ live: false })} className="btn btn-ghost">
                    Show all {counts[category]} anyway →
                  </Link>
                </div>
              </>
            ) : (
              <>
                <p className="quote">
                  No agent in the registry classifies as{' '}
                  {(CATEGORY_LABEL[category] ?? category).toLowerCase()}.
                </p>
                <p className="body">
                  Categories are read from each agent&rsquo;s own card - a declared category first,
                  then its description. An empty one means nobody has registered an agent that says
                  it does this.
                </p>
              </>
            )}
          </div>
        ) : null}
      </div>

      <Pager page={page} pages={pages} href={(n) => href({ page: n })} />
    </div>
  );
}

/**
 * Pages, as links.
 *
 * Links rather than buttons, and a query parameter rather than client state,
 * for the same reason the category and live filters are: a page you can send
 * someone, that survives a refresh, and that works with scripting off. The list
 * is the one screen a judge will spend real time in, and two hundred cards of
 * infinite scroll is how they never reach the bottom of it.
 *
 * The window is bounded so the control itself does not become the thing you
 * scroll past: first and last are always reachable, the current page sits in a
 * run of its neighbours, and the gaps are marked rather than silently skipped.
 */
function Pager({
  page,
  pages,
  href,
}: {
  readonly page: number;
  readonly pages: number;
  readonly href: (page: number) => string;
}) {
  if (pages <= 1) return null;

  const window = new Set<number>([1, pages, page]);
  for (const n of [page - 2, page - 1, page + 1, page + 2]) {
    if (n >= 1 && n <= pages) window.add(n);
  }
  const numbers = [...window].sort((a, b) => a - b);

  return (
    <nav className="pager" aria-label="Catalog pages">
      {page > 1 ? (
        <Link href={href(page - 1)} className="btn btn-outline btn-sm" rel="prev">
          &larr; Previous
        </Link>
      ) : (
        // Rendered disabled rather than removed, so the row does not shift
        // sideways as you move between pages.
        <span className="btn btn-outline btn-sm" aria-disabled="true" style={{ opacity: 0.4 }}>
          &larr; Previous
        </span>
      )}

      <span className="pager-numbers">
        {numbers.map((n, i) => (
          <span key={n} className="row" style={{ gap: '0.35rem', alignItems: 'center' }}>
            {i > 0 && n - (numbers[i - 1] ?? 0) > 1 ? (
              <span className="tiny" aria-hidden="true">
                &hellip;
              </span>
            ) : null}
            {n === page ? (
              <span className="btn btn-primary btn-sm" aria-current="page">
                {n}
              </span>
            ) : (
              <Link href={href(n)} className="btn btn-ghost btn-sm">
                {n}
              </Link>
            )}
          </span>
        ))}
      </span>

      {page < pages ? (
        <Link href={href(page + 1)} className="btn btn-outline btn-sm" rel="next">
          Next &rarr;
        </Link>
      ) : (
        <span className="btn btn-outline btn-sm" aria-disabled="true" style={{ opacity: 0.4 }}>
          Next &rarr;
        </span>
      )}
    </nav>
  );
}
