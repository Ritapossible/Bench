import {
  VERIFIED_LIVE,
  isVerifiedLive,
  redactSecrets,
  AGENT_CATEGORIES,
  summarizeProbes,
  type AgentCard,
  type AgentCategory,
  type AgentEndpoint,
  type AgentId,
  type AgentRecord,
  type Address,
  type CatalogEntry,
  type CatalogPage,
  type CatalogQuery,
  type CatalogRepository,
  type CatalogStats,
  type ChainName,
  type EndpointProtocol,
  type Hex,
  type IndexerCheckpoint,
  type LivenessSummary,
  type ProbeResult,
  type ProbeTarget,
} from '@bench/core';
import { and, asc, count, eq, gte, isNull, notInArray, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import * as schema from './schema.js';

/** The handle inside `db.transaction(...)`. Same query surface as `Db`. */
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Postgres CatalogRepository.
 *
 * Satisfies the same port as InMemoryCatalogRepository in @bench/adapters, so
 * the indexer and prober are identical against both. Two places where the two
 * implementations have to agree deliberately rather than by luck:
 *
 *  1. **A failed re-resolve never erases a good card.** A card host being down
 *     today does not mean the agent stopped being real, so the upsert
 *     coalesces rather than overwrites.
 *  2. **Verified-live is one predicate.** `isVerifiedLive` in @bench/core is
 *     the definition; the SQL below mirrors it and reads its thresholds from
 *     the same `VERIFIED_LIVE` constants, so the numbers cannot diverge. The
 *     *structure* is still duplicated, and that duplication is currently
 *     guarded only by the comment on `verifiedLiveSql`. It needs an
 *     integration test running both against the same fixtures once a test
 *     Postgres is wired up — a filter that drifts would quietly misstate the
 *     headline number on the front page. Tracked as Phase 1 follow-up.
 */

/**
 * Probes folded into a liveness summary. Bounded so an agent probed hourly for
 * a month does not make its own summary progressively more expensive to
 * compute than every other agent's.
 */
const LIVENESS_HISTORY_LIMIT = 500;

export class PgCatalogRepository implements CatalogRepository {
  constructor(private readonly db: Db) {}

  async upsertAgents(records: readonly AgentRecord[]): Promise<number> {
    if (records.length === 0) return 0;

    await this.db.transaction(async (tx) => {
      for (const r of records) {
        const rows = await tx
          .insert(schema.agents)
          .values({
            chain: r.id.chain,
            tokenId: r.id.tokenId.toString(),
            owner: r.owner,
            cardUri: r.cardUri,
            category: r.card?.category ?? 'other',
            card: r.card,
            cardError: r.cardError ?? null,
            registeredAt: r.registeredAt,
          })
          .onConflictDoUpdate({
            target: [schema.agents.chain, schema.agents.tokenId],
            set: {
              owner: sql`excluded.owner`,
              cardUri: sql`excluded.card_uri`,
              // Keep the last card that did resolve.
              card: sql`coalesce(excluded.card, ${schema.agents.card})`,
              category: sql`case when excluded.card is not null then excluded.category else ${schema.agents.category} end`,
              cardError: sql`excluded.card_error`,
              // Repair an unknown registration date when a source that knows it
              // supplies one, but never overwrite a known one with the epoch.
              // Enumeration reads current state, which carries no timestamp and
              // passes the epoch as a placeholder; without this the first
              // enumeration pinned `registeredAt` to 1970 permanently, and a
              // later log scan - which does know the date - could not fix it.
              registeredAt: sql`case
                when ${schema.agents.registeredAt} = to_timestamp(0) then excluded.registered_at
                when excluded.registered_at = to_timestamp(0) then ${schema.agents.registeredAt}
                else least(${schema.agents.registeredAt}, excluded.registered_at)
              end`,
              indexedAt: new Date(),
            },
          })
          .returning({ id: schema.agents.id });

        const agentRow = rows[0];
        if (agentRow === undefined || r.card === null) continue;
        await this.syncEndpoints(tx, agentRow.id, r.card.endpoints);
      }
    });

    return records.length;
  }

  /**
   * Endpoints are replaced, not merged: the card is the source of truth, and
   * an endpoint the agent has withdrawn must stop being probed. Existing rows
   * are left in place so their probe history survives a re-index.
   */
  private async syncEndpoints(
    tx: Tx,
    agentId: string,
    endpoints: readonly AgentEndpoint[],
  ): Promise<void> {
    if (endpoints.length > 0) {
      await tx
        .insert(schema.agentEndpoints)
        .values(endpoints.map((e) => ({ agentId, protocol: e.protocol, url: e.url })))
        .onConflictDoUpdate({
          target: [schema.agentEndpoints.agentId, schema.agentEndpoints.url],
          set: { protocol: sql`excluded.protocol` },
        });
    }

    const keep = endpoints.map((e) => e.url);
    await tx.delete(schema.agentEndpoints).where(
      keep.length === 0
        ? eq(schema.agentEndpoints.agentId, agentId)
        : and(
            eq(schema.agentEndpoints.agentId, agentId),
            // `notInArray` rather than a hand-written `<> all(...)`: drizzle
            // expands an array inside a `sql` template into comma-separated
            // placeholders, so `all(${keep})` passed a bare string for a
            // single-endpoint agent and Postgres rejected it as a malformed
            // array literal. Almost every real agent card has exactly one
            // endpoint, so that was the common case, not the edge one.
            notInArray(schema.agentEndpoints.url, keep),
          ),
    );
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    const rows = await this.db.select().from(schema.agents).where(agentMatches(id)).limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async recordProbe(result: ProbeResult): Promise<void> {
    const ids = await this.resolveIds(result.agent, result.endpoint.url);
    if (ids === null) return; // agent or endpoint removed mid-tick; drop it

    await this.db.insert(schema.probeResults).values({
      agentId: ids.agentId,
      endpointId: ids.endpointId,
      at: result.at,
      reachable: result.reachable,
      latencyMs: result.latencyMs,
      conformant: result.conformant,
      // Redacted and bounded. This string comes from an endpoint a stranger
      // registered, it is rendered on the public agent page, and an error
      // raised while talking to our own infrastructure can carry its URL.
      error: result.error === undefined ? null : redactSecrets(result.error, 500),
    });

    // Recompute rather than increment. Incremental updates to p95 and uptime
    // drift under retries and out-of-order writes; a bounded recompute is
    // cheap and always agrees with the probe rows behind it.
    await this.refreshLiveness(result.agent, ids.agentId);
  }

  private async refreshLiveness(agent: AgentId, agentUuid: string): Promise<LivenessSummary> {
    const probes = await this.recentProbes(agentUuid, agent);
    const summary = summarizeProbes(agent, probes);

    await this.db
      .insert(schema.agentLiveness)
      .values({
        agentId: agentUuid,
        lastProbedAt: summary.lastProbedAt,
        reachable: summary.reachable,
        conformant: summary.conformant,
        uptimeBps: summary.uptimeBps,
        p95LatencyMs: summary.p95LatencyMs,
        probeCount: summary.probeCount,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.agentLiveness.agentId,
        set: {
          lastProbedAt: sql`excluded.last_probed_at`,
          reachable: sql`excluded.reachable`,
          conformant: sql`excluded.conformant`,
          uptimeBps: sql`excluded.uptime_bps`,
          p95LatencyMs: sql`excluded.p95_latency_ms`,
          probeCount: sql`excluded.probe_count`,
          updatedAt: new Date(),
        },
      });

    return summary;
  }

  private async recentProbes(agentUuid: string, agent: AgentId): Promise<ProbeResult[]> {
    const rows = await this.db
      .select({
        at: schema.probeResults.at,
        reachable: schema.probeResults.reachable,
        latencyMs: schema.probeResults.latencyMs,
        conformant: schema.probeResults.conformant,
        error: schema.probeResults.error,
        protocol: schema.agentEndpoints.protocol,
        url: schema.agentEndpoints.url,
      })
      .from(schema.probeResults)
      .innerJoin(
        schema.agentEndpoints,
        eq(schema.probeResults.endpointId, schema.agentEndpoints.id),
      )
      .where(eq(schema.probeResults.agentId, agentUuid))
      .orderBy(sql`${schema.probeResults.at} desc`)
      .limit(LIVENESS_HISTORY_LIMIT);

    return rows.map((r) => ({
      agent,
      endpoint: { protocol: r.protocol as EndpointProtocol, url: r.url },
      at: r.at,
      reachable: r.reachable,
      latencyMs: r.latencyMs,
      conformant: r.conformant,
      ...(r.error === null ? {} : { error: r.error }),
    }));
  }

  async liveness(agent: AgentId): Promise<LivenessSummary> {
    const rows = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(agentMatches(agent))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return summarizeProbes(agent, []);

    const cached = await this.db
      .select()
      .from(schema.agentLiveness)
      .where(eq(schema.agentLiveness.agentId, row.id))
      .limit(1);
    const c = cached[0];
    if (c === undefined) return summarizeProbes(agent, []);

    return {
      agent,
      lastProbedAt: c.lastProbedAt,
      reachable: c.reachable,
      conformant: c.conformant,
      uptimeBps: c.uptimeBps,
      p95LatencyMs: c.p95LatencyMs,
      probeCount: c.probeCount,
    };
  }

  /**
   * Never-probed endpoints first, then least-recently-probed. A catalog bigger
   * than one tick still cycles fairly — and its tail is where the dead agents
   * are, which is exactly what the filter needs to know about.
   */
  async dueForProbe(
    limit: number,
    staleAfterMs: number,
    bootstrap?: { readonly afterMs: number; readonly untilProbeCount: number },
  ): Promise<readonly ProbeTarget[]> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const bootstrapCutoff =
      bootstrap === undefined ? null : new Date(Date.now() - bootstrap.afterMs);

    const rows = await this.db
      .select({
        chain: schema.agents.chain,
        tokenId: schema.agents.tokenId,
        protocol: schema.agentEndpoints.protocol,
        url: schema.agentEndpoints.url,
        lastProbedAt: sql<Date | null>`max(${schema.probeResults.at})`.as('last_probed_at'),
      })
      .from(schema.agentEndpoints)
      .innerJoin(schema.agents, eq(schema.agentEndpoints.agentId, schema.agents.id))
      .leftJoin(schema.probeResults, eq(schema.probeResults.endpointId, schema.agentEndpoints.id))
      .groupBy(
        schema.agentEndpoints.id,
        schema.agents.chain,
        schema.agents.tokenId,
        schema.agentEndpoints.protocol,
        schema.agentEndpoints.url,
      )
      .having(
        bootstrapCutoff === null
          ? sql`max(${schema.probeResults.at}) is null or max(${schema.probeResults.at}) < ${cutoff}`
          : sql`max(${schema.probeResults.at}) is null
                 or max(${schema.probeResults.at}) < ${cutoff}
                 or (count(${schema.probeResults.id}) < ${bootstrap?.untilProbeCount ?? 0}
                     and max(${schema.probeResults.at}) < ${bootstrapCutoff})`,
      )
      // Endpoints with no verdict yet come first: a probe that completes a
      // verdict is worth more than the nth probe of one already decided.
      .orderBy(
        sql`count(${schema.probeResults.id}) asc, max(${schema.probeResults.at}) asc nulls first`,
      )
      .limit(limit);

    return rows.map((r) => ({
      agent: { chain: r.chain as ChainName, tokenId: BigInt(r.tokenId) },
      endpoint: { protocol: r.protocol as EndpointProtocol, url: r.url },
      lastProbedAt: r.lastProbedAt === null ? null : new Date(r.lastProbedAt),
    }));
  }

  async unanchoredProbes(limit: number): Promise<readonly ProbeResult[]> {
    const rows = await this.db
      .select({
        at: schema.probeResults.at,
        reachable: schema.probeResults.reachable,
        latencyMs: schema.probeResults.latencyMs,
        conformant: schema.probeResults.conformant,
        error: schema.probeResults.error,
        chain: schema.agents.chain,
        tokenId: schema.agents.tokenId,
        protocol: schema.agentEndpoints.protocol,
        url: schema.agentEndpoints.url,
      })
      .from(schema.probeResults)
      .innerJoin(schema.agents, eq(schema.probeResults.agentId, schema.agents.id))
      .innerJoin(
        schema.agentEndpoints,
        eq(schema.probeResults.endpointId, schema.agentEndpoints.id),
      )
      .where(isNull(schema.probeResults.anchoredDigest))
      .orderBy(asc(schema.probeResults.at))
      .limit(limit);

    return rows.map((r) => ({
      agent: { chain: r.chain as ChainName, tokenId: BigInt(r.tokenId) },
      endpoint: { protocol: r.protocol as EndpointProtocol, url: r.url },
      at: r.at,
      reachable: r.reachable,
      latencyMs: r.latencyMs,
      conformant: r.conformant,
      ...(r.error === null ? {} : { error: r.error }),
    }));
  }

  async markProbesAnchored(upTo: Date, digest: Hex, txHash: Hex): Promise<number> {
    return this.db.transaction(async (tx) => {
      const previous = await tx
        .select({ digest: schema.probeAnchors.digest })
        .from(schema.probeAnchors)
        .orderBy(sql`${schema.probeAnchors.createdAt} desc`)
        .limit(1);

      const marked = await tx
        .update(schema.probeResults)
        .set({ anchoredDigest: digest })
        .where(
          and(
            isNull(schema.probeResults.anchoredDigest),
            sql`${schema.probeResults.at} <= ${upTo}`,
          ),
        )
        .returning({ id: schema.probeResults.id });

      await tx.insert(schema.probeAnchors).values({
        digest,
        previousDigest: previous[0]?.digest ?? `0x${'00'.repeat(32)}`,
        txHash,
        coversUpTo: upTo,
        probeCount: marked.length,
      });

      return marked.length;
    });
  }

  async lastAnchoredDigest(): Promise<Hex | null> {
    const rows = await this.db
      .select({ digest: schema.probeAnchors.digest })
      .from(schema.probeAnchors)
      .orderBy(sql`${schema.probeAnchors.createdAt} desc`)
      .limit(1);
    return (rows[0]?.digest as Hex | undefined) ?? null;
  }

  async query(q: CatalogQuery): Promise<CatalogPage> {
    const limit = q.limit ?? 50;
    const offset = q.cursor === undefined ? 0 : Number.parseInt(q.cursor, 10);

    const conditions = [
      ...(q.chain === undefined ? [] : [eq(schema.agents.chain, q.chain)]),
      ...(q.category === undefined ? [] : [eq(schema.agents.category, q.category)]),
      ...(q.verifiedLiveOnly === true ? [verifiedLiveSql()] : []),
    ];

    const rows = await this.db
      .select({ agent: schema.agents, live: schema.agentLiveness })
      .from(schema.agents)
      .leftJoin(schema.agentLiveness, eq(schema.agentLiveness.agentId, schema.agents.id))
      .where(conditions.length === 0 ? undefined : and(...conditions))
      .orderBy(asc(schema.agents.tokenId))
      // One extra row is the cheapest possible has-next-page check.
      .limit(limit + 1)
      .offset(offset);

    const page = rows.slice(0, limit);
    const entries: CatalogEntry[] = page.map((r) => {
      const record = toRecord(r.agent);
      const liveness: LivenessSummary =
        r.live === null
          ? summarizeProbes(record.id, [])
          : {
              agent: record.id,
              lastProbedAt: r.live.lastProbedAt,
              reachable: r.live.reachable,
              conformant: r.live.conformant,
              uptimeBps: r.live.uptimeBps,
              p95LatencyMs: r.live.p95LatencyMs,
              probeCount: r.live.probeCount,
            };
      return { record, liveness, verifiedLive: isVerifiedLive(liveness) };
    });

    return {
      entries,
      nextCursor: rows.length > limit ? String(offset + limit) : null,
    };
  }

  async stats(chain: ChainName): Promise<CatalogStats> {
    const [registered] = await this.db
      .select({ n: count() })
      .from(schema.agents)
      .where(eq(schema.agents.chain, chain));

    const [withCard] = await this.db
      .select({ n: count() })
      .from(schema.agents)
      .where(and(eq(schema.agents.chain, chain), sql`${schema.agents.card} is not null`));

    const [live] = await this.db
      .select({ n: count() })
      .from(schema.agents)
      .leftJoin(schema.agentLiveness, eq(schema.agentLiveness.agentId, schema.agents.id))
      .where(and(eq(schema.agents.chain, chain), verifiedLiveSql()));

    return {
      chain,
      registered: registered?.n ?? 0,
      withResolvableCard: withCard?.n ?? 0,
      verifiedLive: live?.n ?? 0,
      computedAt: new Date(),
    };
  }

  async categoryCounts(
    chain: ChainName,
    opts: { readonly verifiedLiveOnly?: boolean } = {},
  ): Promise<Readonly<Record<AgentCategory, number>>> {
    // One grouped count over the catalog, not a tally of whatever page the UI
    // happened to load. Every category is present in the result even at zero,
    // so a caller rendering tabs does not have to know the category list twice.
    const rows = await this.db
      .select({ category: schema.agents.category, n: count() })
      .from(schema.agents)
      .leftJoin(schema.agentLiveness, eq(schema.agentLiveness.agentId, schema.agents.id))
      .where(
        opts.verifiedLiveOnly === true
          ? and(eq(schema.agents.chain, chain), verifiedLiveSql())
          : eq(schema.agents.chain, chain),
      )
      .groupBy(schema.agents.category);

    const out: Record<string, number> = {};
    for (const c of AGENT_CATEGORIES) out[c] = 0;
    for (const r of rows) {
      if (r.category in out) out[r.category] = r.n;
    }
    return out as Readonly<Record<AgentCategory, number>>;
  }

  async checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null> {
    const rows = await this.db
      .select()
      .from(schema.indexerCheckpoints)
      .where(eq(schema.indexerCheckpoints.chain, chain))
      .limit(1);
    const row = rows[0];
    return row === undefined
      ? null
      : {
          chain,
          lastBlock: row.lastBlock,
          lastTokenId: row.lastTokenId,
          updatedAt: row.updatedAt,
        };
  }

  async setCheckpoint(chain: ChainName, lastBlock: bigint): Promise<void> {
    await this.db
      .insert(schema.indexerCheckpoints)
      .values({ chain, lastBlock, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.indexerCheckpoints.chain,
        set: { lastBlock: sql`excluded.last_block`, updatedAt: new Date() },
      });
  }

  /**
   * Advance the enumeration cursor without touching the block cursor.
   *
   * `lastBlock` is defaulted to 0 on insert rather than left out: the column is
   * NOT NULL because a log-scanning deployment must always have one, and a
   * deployment that only enumerates simply never moves it off zero.
   */
  async setTokenCursor(chain: ChainName, lastTokenId: bigint): Promise<void> {
    await this.db
      .insert(schema.indexerCheckpoints)
      .values({ chain, lastBlock: 0n, lastTokenId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: schema.indexerCheckpoints.chain,
        set: { lastTokenId: sql`excluded.last_token_id`, updatedAt: new Date() },
      });
  }

  private async resolveIds(
    agent: AgentId,
    url: string,
  ): Promise<{ agentId: string; endpointId: string } | null> {
    const rows = await this.db
      .select({ agentId: schema.agents.id, endpointId: schema.agentEndpoints.id })
      .from(schema.agents)
      .innerJoin(schema.agentEndpoints, eq(schema.agentEndpoints.agentId, schema.agents.id))
      .where(and(agentMatches(agent), eq(schema.agentEndpoints.url, url)))
      .limit(1);
    return rows[0] ?? null;
  }
}

const agentMatches = (id: AgentId) =>
  and(eq(schema.agents.chain, id.chain), eq(schema.agents.tokenId, id.tokenId.toString()));

/**
 * SQL mirror of `isVerifiedLive` from @bench/core.
 *
 * The thresholds are read from the shared `VERIFIED_LIVE` constants so the
 * numbers cannot diverge; the *structure* is duplicated. If you edit one of
 * these, edit the other — there is no test holding them together yet.
 */
function verifiedLiveSql() {
  const cutoff = new Date(Date.now() - VERIFIED_LIVE.maxProbeAgeMs);
  return and(
    eq(schema.agentLiveness.reachable, true),
    eq(schema.agentLiveness.conformant, true),
    gte(schema.agentLiveness.probeCount, VERIFIED_LIVE.minProbeCount),
    gte(schema.agentLiveness.uptimeBps, VERIFIED_LIVE.minUptimeBps),
    gte(schema.agentLiveness.lastProbedAt, cutoff),
  );
}

type AgentRow = typeof schema.agents.$inferSelect;

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: { chain: row.chain as ChainName, tokenId: BigInt(row.tokenId) },
    owner: row.owner as Address,
    cardUri: row.cardUri,
    card: (row.card as AgentCard | null) ?? null,
    ...(row.cardError === null ? {} : { cardError: row.cardError }),
    registeredAt: row.registeredAt,
  };
}
