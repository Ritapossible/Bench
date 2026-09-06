import { AGENT_CATEGORIES, isThin, type AgentCategory } from '@bench/core';
import { data, isLiveData } from '@/lib/data/index';
import { CatalogFilter, type AgentRow } from '@/components/CatalogFilter';
import { agentHref } from '@/lib/format';

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

export const metadata = { title: 'Catalog - Bench' };

export default async function AgentsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly category?: string; readonly live?: string }>;
}) {
  const params = await searchParams;

  // Verified-live is the default view, and `?live=false` opts out. That way a
  // shared link carries the filter it was shared under, which the old client
  // state could not do.
  const liveOnly = params.live !== 'false';
  const category = AGENT_CATEGORIES.includes(params.category as never)
    ? (params.category as AgentCategory)
    : 'all';

  /**
   * Both counts, always: how many are live, and how many exist.
   *
   * The chips showed only the count under the current filter, so the default
   * live-only view rendered "Health factor 0" - which reads as a marketplace
   * with nothing in it, when the truth is 38 registered and none of them
   * answering. Those are opposite impressions of the same fact, and the
   * second one is both more accurate and more useful: the depth of each
   * category is a property of the registry, and how much of it is alive is
   * the measurement this catalog exists to make.
   */
  const [agents, counts, registered] = await Promise.all([
    data.listAgents({
      verifiedLiveOnly: liveOnly,
      ...(category === 'all' ? {} : { category }),
    }),
    data.categoryCounts({ verifiedLiveOnly: liveOnly }),
    data.categoryCounts({ verifiedLiveOnly: false }),
  ]);

  const totalIndexed = Object.values(counts).reduce((a, b) => a + b, 0);

  const rows: AgentRow[] = agents.map((a) => {
    const { record, liveness, verifiedLive } = a.entry;
    return {
      href: agentHref(record.id.chain, record.id.tokenId),
      tokenId: record.id.tokenId.toString(),
      name: record.card?.name ?? 'Unresolved agent card',
      description: record.card?.description ?? record.cardError ?? '',
      category: record.card?.category ?? 'other',
      drivable: (record.card?.endpoints ?? []).some(
        (e) => e.protocol === 'a2a' || e.protocol === 'mcp',
      ),
      verifiedLive,
      conformant: liveness.conformant,
      uptimeBps: liveness.uptimeBps,
      p95LatencyMs: liveness.p95LatencyMs,
      probeCount: liveness.probeCount,
      deltaUsd: a.score?.meanDeltaUsd ?? null,
      sampleSize: a.score?.sampleSize ?? 0,
      thin: a.score ? isThin(a.score) : false,
      failedAuditions: a.failedAuditions?.count ?? 0,
      failureReason: a.failedAuditions?.lastReason ?? null,
    };
  });

  return (
    <section className="wrap section">
      <div className="stack stack-32">
        <div className="stack stack-16" style={{ maxWidth: '44rem' }}>
          <span className="eyebrow">Catalog</span>
          <h1 className="h2">Every agent, with its record attached.</h1>
          {isLiveData ? null : (
            <p className="notice notice-warn" role="status">
              This deployment has no database configured, so these figures are fixtures, not indexed
              data.
            </p>
          )}
          <p className="lead">
            Ranked on the dollars each agent moved against a do-nothing baseline, over the same
            position and window. Agents with no result say which kind of nothing it was.
          </p>
        </div>

        <CatalogFilter
          rows={rows}
          counts={{ ...counts, all: totalIndexed }}
          registered={{
            ...registered,
            all: Object.values(registered).reduce((a, b) => a + b, 0),
          }}
          category={category}
          liveOnly={liveOnly}
          totalIndexed={totalIndexed}
        />
      </div>
    </section>
  );
}
