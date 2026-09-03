import { isThin } from '@bench/core';
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

export default async function AgentsPage() {
  const agents = await data.listAgents();

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
      deltaUsd: a.score ? (a.score.normalized - 0.5) * 800 : null,
      sampleSize: a.score?.sampleSize ?? 0,
      thin: a.score ? isThin(a.score) : false,
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
            Ranked on what each agent did in audition against a do-nothing baseline. Agents with no
            completed auditions are listed and probed, and say so - they are never given a
            fabricated number.
          </p>
        </div>

        <CatalogFilter rows={rows} />
      </div>
    </section>
  );
}
