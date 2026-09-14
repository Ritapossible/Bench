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
import {
  and,
  asc,
  count,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  sql,
} from 'drizzle-orm';
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

/**
 * ============================================================================
 * What a card costs to keep, weighed against what it can ever be used for.
 * ============================================================================
 *
 * Two trims, both forced by a 512 MB ceiling that 345,879 mainnet
 * registrations went through - every write failing with "could not extend
 * file", the prober unable to record a probe, and the catalog reporting zero
 * verified-live agents because liveness could not be refreshed rather than
 * because anything had died.
 *
 * **`raw` goes for every card.** It is the whole original registration, kept
 * so a later parser improvement could re-mine indexed cards without
 * re-fetching. Fair at 2,400 testnet agents; at 345,879 it duplicates the
 * name, description and endpoints stored beside it in their own columns, and
 * on this registry it also carries whatever else a stranger put in a
 * registration - pasted shell scripts, multi-kilobyte prose, JSON fragments.
 * Nothing reads it; re-mining still works and costs a re-fetch, which the
 * sweep already does.
 *
 * **A card with nothing callable in it keeps only its name.** Measured over a
 * uniform sample, 88.6% of these registrations declare no A2A or MCP endpoint
 * at all: they cannot be probed, auditioned or hired, and no page shows more
 * of them than a name and a category. Their descriptions are the single
 * largest remaining weight in the table and are read by nobody.
 *
 * The row itself stays, and the card stays non-null, which matters: the
 * registry-health figures are `count(*)` and `count(card is not null)` over
 * this table, and they are the denominators that make "0.45% live" mean
 * anything. Dropping the rows would have made the headline number cheaper to
 * store and impossible to state.
 */
function storable(card: AgentCard | null): Omit<AgentCard, 'raw'> | null {
  if (card === null) return null;
  const { raw: _raw, ...rest } = card;

  const callable = rest.endpoints.some((e) => e.protocol === 'a2a' || e.protocol === 'mcp');
  if (callable) return rest;

  return {
    name: rest.name,
    description: '',
    category: rest.category,
    endpoints: [],
    permissions: { contractAllowlist: [], requiresTokenApprovals: false },
  };
}

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
            card: storable(r.card),
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
    coldAfterMs?: number,
  ): Promise<readonly ProbeTarget[]> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const bootstrapCutoff =
      bootstrap === undefined ? null : new Date(Date.now() - bootstrap.afterMs);
    /**
     * The demotion cutoff for endpoints that have never answered.
     *
     * `bool_or(reachable)` is already available here for free - the query
     * groups by endpoint either way - so the tier costs one more aggregate and
     * no extra round trip.
     */
    const coldCutoff = coldAfterMs === undefined ? null : new Date(Date.now() - coldAfterMs);
    const everReachable = sql`bool_or(${schema.probeResults.reachable})`;
    /**
     * Has this endpoint ever spoken its own protocol?
     *
     * Distinct from `everReachable`: a web server that answers 200 to
     * everything is reachable and never conformant, and only a conformant
     * endpoint can hold a verdict that expires. One more aggregate over a
     * group the query already forms.
     */
    const everConformant = sql`bool_or(${schema.probeResults.conformant})`;
    const lastAt = sql`max(${schema.probeResults.at})`;
    const seen = sql`count(${schema.probeResults.id})`;
    /**
     * Due because it is stale, at whichever cadence this endpoint has earned.
     *
     * An endpoint with no probes at all is due immediately and is handled by
     * the `is null` arm - it has not earned the cold tier, it has not been
     * asked yet.
     */
    const stale =
      coldCutoff === null
        ? sql`${lastAt} < ${cutoff}`
        : sql`(${everReachable} and ${lastAt} < ${cutoff})
               or (not ${everReachable} and ${lastAt} < ${coldCutoff})`;

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
          ? sql`${lastAt} is null or (${stale})`
          : // An endpoint still short of a verdict keeps the bootstrap cadence
            // whatever tier it would otherwise fall into: "never answered" is
            // not a conclusion until enough probes have asked.
            sql`${lastAt} is null
                 or (${stale})
                 or (${seen} < ${bootstrap?.untilProbeCount ?? 0} and ${lastAt} < ${bootstrapCutoff})`,
      )
      /**
       * Finish verdicts before starting new ones.
       *
       * `seen asc` did the opposite of what its comment claimed. Every
       * never-probed endpoint sorts ahead of one probed twice, and the indexer
       * adds thousands of never-probed endpoints a day, so the backlog never
       * empties and nothing ever reaches the three probes `isVerifiedLive`
       * requires. The site sat at "0 verified live" indefinitely - with a
       * reference agent whose own page read uptime 100%, p95 276ms, probes 1.
       *
       * So an endpoint part-way to a verdict outranks an unprobed one. It
       * cannot starve discovery: a part-way endpoint needs at most two more
       * probes and then leaves the class, and the bootstrap cadence keeps it
       * out of the batch for two minutes between them.
       *
       * **And a verdict already reached outranks one not yet started.** The
       * same starvation returned one level up as soon as the catalog grew.
       * `isVerifiedLive` requires a probe inside six hours, an endpoint that
       * has answered before sorts as an ordinary stale re-check, and the
       * indexer had taken the catalog from 32,000 agents to 196,749 overnight
       * - so tens of thousands of never-probed endpoints stood in front of
       * every established verdict and they expired unrefreshed. Verified live
       * fell from 44 to 23 while every one of them was still answering:
       * Bench's own reference agent read uptime 100.0%, p95 878ms, reachable
       * yes, speaks its protocol yes - last probed eleven hours ago.
       *
       * That is not a measurement of the ecosystem, it is a measurement of the
       * queue. The six-hour rule exists to make "live" mean *now*; if the
       * prober cannot return inside it, the number says how far the queue got
       * rather than which agents are up. Refreshing costs nothing next to
       * discovery - a few dozen endpoints against a batch of six hundred - and
       * without it the figure decays toward zero purely as the catalog grows,
       * which is the opposite of what indexing more of the registry should do.
       */
      .orderBy(
        sql`case
              when ${seen} > 0 and ${seen} < ${bootstrap?.untilProbeCount ?? 0} then 0
              when ${everConformant} then 1
              when ${seen} = 0 then 2
              else 3
            end asc,
            ${lastAt} asc nulls first`,
      )
      .limit(limit);

    return rows.map((r) => ({
      agent: { chain: r.chain as ChainName, tokenId: BigInt(r.tokenId) },
      endpoint: { protocol: r.protocol as EndpointProtocol, url: r.url },
      lastProbedAt: r.lastProbedAt === null ? null : new Date(r.lastProbedAt),
    }));
  }

  /**
   * `pg_database_size`, which counts what a hosted plan counts: tables,
   * indexes and the bloat that a delete leaves behind until it is vacuumed.
   * Reading the sum of table sizes instead would under-report exactly when it
   * matters most.
   */
  async sizeBytes(): Promise<number> {
    const rows = await this.db.execute(
      sql`select pg_database_size(current_database())::bigint as bytes`,
    );
    const first = (rows as unknown as { rows: { bytes: string | number }[] }).rows[0];
    return first === undefined ? 0 : Number(first.bytes);
  }

  /**
   * The registry's size, as opposed to the catalog's.
   *
   * `token_id` is numeric(78) rather than bigint - registry ids are uint256 -
   * so the max has to be taken numerically and cast back, not compared as
   * text, where '9' sorts after '346444'.
   */
  async highestTokenId(chain: ChainName): Promise<bigint | null> {
    const rows = await this.db.execute(
      sql`select max(token_id)::text as top from agents where chain = ${chain}`,
    );
    const first = (rows as unknown as { rows: { top: string | null }[] }).rows[0];
    const top = first?.top ?? null;
    return top === null ? null : BigInt(top);
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

  /**
   * Drop probe results older than the retention window.
   *
   * The prober writes up to two hundred rows a minute and nothing ever removed
   * one, so the table grew without bound - which fills a small Postgres plan in
   * weeks and makes every `dueForProbe` aggregate slower in the meantime.
   *
   * Liveness does not need the history: `agent_liveness` is a rolling summary
   * recomputed on every write, and `isVerifiedLive` looks at a short window, so
   * older raw rows inform no answer.
   */
  async pruneProbeResults(
    olderThanMs: number,
    opts: { readonly keepUnanchored?: boolean; readonly limit?: number } = {},
  ): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    /**
     * Whether an unanchored row is still owed a digest.
     *
     * The first version kept every unanchored row unconditionally, which reads
     * as caution and is a no-op: anchoring needs a signer and a validation
     * registry, is off in every deployment so far, and so `anchored_digest` is
     * null on every row ever written. Retention that never deletes anything is
     * worse than none, because it looks like the problem is handled.
     *
     * So the caller says whether anchoring is actually running. When it is, an
     * unanchored row is evidence still owed to a public claim and is kept
     * however old it is. When it is not, nothing is ever going to anchor it and
     * age alone governs.
     */
    const keepUnanchored = opts.keepUnanchored ?? false;
    const doomed = await this.db
      .select({ id: schema.probeResults.id })
      .from(schema.probeResults)
      .where(
        keepUnanchored
          ? and(lt(schema.probeResults.at, cutoff), isNotNull(schema.probeResults.anchoredDigest))
          : lt(schema.probeResults.at, cutoff),
      )
      .limit(opts.limit ?? 20_000);

    if (doomed.length === 0) return 0;
    await this.db.delete(schema.probeResults).where(
      inArray(
        schema.probeResults.id,
        doomed.map((d) => d.id),
      ),
    );
    return doomed.length;
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
    // `raw` is not persisted - see `storable`. Restored as null rather than
    // left absent, so a card read back from the database satisfies the same
    // type as one just parsed, and no caller has to know which it is holding.
    card: row.card === null ? null : { ...(row.card as Omit<AgentCard, 'raw'>), raw: null },
    ...(row.cardError === null ? {} : { cardError: row.cardError }),
    registeredAt: row.registeredAt,
  };
}
