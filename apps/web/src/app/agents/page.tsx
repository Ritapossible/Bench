import { isThin } from '@bench/core';
import { data } from '@/lib/data/index';
import { CatalogFilter, type AgentRow } from '@/components/CatalogFilter';
import { agentHref } from '@/lib/format';

export const metadata = { title: 'Catalog — Bench' };

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
          <p className="lead">
            Ranked on what each agent did in audition against a do-nothing baseline. Agents with no completed
            auditions are listed and probed, and say so — they are never given a fabricated number.
          </p>
        </div>

        <CatalogFilter rows={rows} />
      </div>
    </section>
  );
}
