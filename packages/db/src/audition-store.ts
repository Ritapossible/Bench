import {
  agentKey,
  BenchError,
  type AgentCategory,
  type AgentId,
  type AgreementSummary,
  type AuditionStore,
  type AuditionWindow,
  type Baseline,
  type CatalogStats,
  type CategoryMetric,
  type ChainName,
  type Address,
  type AuditionEvidence,
  type Hex,
  type InterceptedAction,
  type OutcomeRecord,
  type PositionTemplate,
  type Score,
  type ScoreBasis,
  type ShadowRun,
  type ShadowRunStatus,
  type TerminalState,
} from '@bench/core';
import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Db } from './index.js';
import * as schema from './schema.js';

/**
 * Postgres AuditionStore - ARCHITECTURE.md 3.3 and 3.4.
 *
 * The evidence half of the catalog: what each agent did in audition, what it
 * came out with, and the score derived from that. Three decisions worth
 * stating, because each is a place a simpler implementation would quietly
 * mislead:
 *
 *  1. **Scores are read in one query per page, not one per row.** `latestScores`
 *     takes the whole page's agents at once. A per-agent query is a catalog
 *     that gets slower the more agents Bench indexes, which is the wrong
 *     direction for a marketplace selling breadth.
 *  2. **Unscored is not zero.** `latestScores` returns a map with entries only
 *     for agents that have a score, so the caller can render "not audited yet"
 *     rather than a zero that looks like a verdict.
 *  3. **Bases are never merged.** Every read takes a `basis`, and simulated and
 *     realized scores are separate rows by primary key. There is no query here
 *     that can accidentally average a backtest with a settled job.
 */

type Json = Record<string, unknown>;

const chainOf = (s: string): ChainName => s as ChainName;

/** `numeric(78,0)` arrives as a string; every conversion back to bigint goes through here. */
const toBigInt = (v: string | number | null): bigint => BigInt(v ?? 0);

export class PgAuditionStore implements AuditionStore {
  constructor(private readonly db: Db) {}

  // ------------------------------------------------------------------- runs

  async putRun(run: ShadowRun, actions: readonly InterceptedAction[]): Promise<void> {
    const agentUuid = await this.#agentUuid(run.agent);

    // One transaction: a run whose actions half-landed is worse than no run at
    // all, because the action count feeds the score.
    await this.db.transaction(async (tx) => {
      await tx
        .insert(schema.auditionWindows)
        .values({
          id: run.window.id,
          label: run.window.label,
          regime: run.window.regime,
          forkBlock: run.window.forkBlock,
          endBlock: run.window.endBlock,
          seed: run.window.seed,
        })
        .onConflictDoNothing();

      await tx
        .insert(schema.shadowRuns)
        .values({
          id: run.id,
          agentId: agentUuid,
          windowId: run.window.id,
          positionKind: run.position.kind,
          positionParams: encPosition(run.position),
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          egressSpentUsd: run.egressSpentUsd,
          failureReason: run.failureReason ?? null,
        })
        .onConflictDoUpdate({
          target: schema.shadowRuns.id,
          set: {
            status: run.status,
            startedAt: run.startedAt,
            finishedAt: run.finishedAt,
            egressSpentUsd: run.egressSpentUsd,
            failureReason: run.failureReason ?? null,
          },
        });

      // Replaced wholesale rather than appended, so re-recording a run cannot
      // double its action count.
      await tx.delete(schema.shadowActions).where(eq(schema.shadowActions.runId, run.id));
      if (actions.length > 0) {
        await tx.insert(schema.shadowActions).values(
          actions.map((a) => ({
            runId: run.id,
            seq: a.seq,
            at: a.at,
            to: a.to,
            value: a.value.toString(),
            data: a.data,
            decoded: a.decoded === null ? null : (a.decoded as unknown as Json),
            simSuccess: a.simulated.success,
            simGasUsed: a.simulated.gasUsed.toString(),
            revertReason: a.simulated.revertReason ?? null,
          })),
        );
      }
    });
  }

  async runsFor(agent: AgentId, limit = 20): Promise<readonly ShadowRun[]> {
    const rows = await this.db
      .select({ run: schema.shadowRuns, window: schema.auditionWindows })
      .from(schema.shadowRuns)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.shadowRuns.agentId))
      .innerJoin(schema.auditionWindows, eq(schema.auditionWindows.id, schema.shadowRuns.windowId))
      .where(agentMatches(agent))
      .orderBy(desc(schema.shadowRuns.startedAt))
      .limit(limit);

    return rows.map(({ run, window }) => ({
      id: run.id,
      agent,
      window: {
        id: window.id,
        label: window.label,
        regime: window.regime as AuditionWindow['regime'],
        forkBlock: window.forkBlock,
        endBlock: window.endBlock,
        seed: window.seed,
      },
      position: decPosition(run.positionKind, run.positionParams as Json),
      status: run.status as ShadowRunStatus,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      egressSpentUsd: run.egressSpentUsd,
      ...(run.failureReason === null ? {} : { failureReason: run.failureReason }),
    }));
  }

  /**
   * Actions for a set of runs, in one query, grouped by run.
   *
   * The counterpart `putRun` never had. See the port for why its absence was a
   * correctness problem rather than a missing convenience.
   */
  async actionsForRuns(
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly InterceptedAction[]>> {
    const out = new Map<string, InterceptedAction[]>();
    if (runIds.length === 0) return out;

    const rows = await this.db
      .select()
      .from(schema.shadowActions)
      .where(inArray(schema.shadowActions.runId, [...runIds]))
      // seq, not insertion order: the envelope folds a run's actions in the
      // order the agent took them, and a cumulative bound over a shuffled run
      // is not the bound the agent established.
      .orderBy(asc(schema.shadowActions.runId), asc(schema.shadowActions.seq));

    for (const r of rows) {
      const list = out.get(r.runId) ?? [];
      list.push({
        seq: r.seq,
        at: r.at,
        to: r.to === null ? null : (r.to as Address),
        value: BigInt(r.value),
        data: r.data as Hex,
        decoded: r.decoded as InterceptedAction['decoded'],
        simulated: {
          success: r.simSuccess,
          gasUsed: BigInt(r.simGasUsed),
          ...(r.revertReason === null ? {} : { revertReason: r.revertReason }),
        },
      });
      out.set(r.runId, list);
    }
    return out;
  }

  /**
   * Agents holding at least one outcome, most recently audited first.
   *
   * See the port for why the scorer is driven by this rather than by a page of
   * the catalog. Distinct on the agent because an agent audited five times is
   * one thing to score, not five.
   */
  async agentsWithOutcomes(
    chain: ChainName,
    limit = 200,
  ): Promise<readonly { readonly agent: AgentId; readonly category: AgentCategory }[]> {
    const rows = await this.db
      .selectDistinctOn([schema.agents.tokenId], {
        tokenId: schema.agents.tokenId,
        card: schema.agents.card,
        startedAt: schema.shadowRuns.startedAt,
      })
      .from(schema.outcomeRecords)
      .innerJoin(schema.shadowRuns, eq(schema.shadowRuns.id, schema.outcomeRecords.runId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.shadowRuns.agentId))
      .where(eq(schema.agents.chain, chain))
      .orderBy(schema.agents.tokenId, desc(schema.shadowRuns.startedAt))
      .limit(limit);

    return rows.map((r) => ({
      agent: { chain, tokenId: BigInt(r.tokenId) },
      category: ((r.card as { category?: AgentCategory } | null)?.category ??
        'other') as AgentCategory,
    }));
  }

  /**
   * Completed auditions and their evidence, newest first.
   *
   * One query for the runs and one for their actions, rather than a query per
   * run: the report shows a handful of tasks, but the shape that gets slower as
   * the catalog grows is the one that ends up in production.
   */
  async completedAuditions(chain: ChainName, limit = 10): Promise<readonly AuditionEvidence[]> {
    const rows = await this.db
      .select({
        run: schema.shadowRuns,
        window: schema.auditionWindows,
        outcome: schema.outcomeRecords,
        tokenId: schema.agents.tokenId,
        card: schema.agents.card,
      })
      .from(schema.outcomeRecords)
      .innerJoin(schema.shadowRuns, eq(schema.shadowRuns.id, schema.outcomeRecords.runId))
      .innerJoin(schema.auditionWindows, eq(schema.auditionWindows.id, schema.shadowRuns.windowId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.shadowRuns.agentId))
      .where(and(eq(schema.agents.chain, chain), eq(schema.shadowRuns.status, 'complete')))
      .orderBy(desc(schema.shadowRuns.startedAt))
      .limit(limit);

    const actions = await this.actionsForRuns(rows.map((r) => r.run.id));

    return rows.map(({ run, window, outcome, tokenId, card }) => {
      const agent: AgentId = { chain, tokenId: BigInt(tokenId) };
      const c = card as { name?: string; category?: AgentCategory } | null;
      return {
        run: {
          id: run.id,
          agent,
          window: {
            id: window.id,
            label: window.label,
            regime: window.regime as AuditionWindow['regime'],
            forkBlock: window.forkBlock,
            endBlock: window.endBlock,
            seed: window.seed,
          },
          position: decPosition(run.positionKind, run.positionParams as Json),
          status: run.status as ShadowRunStatus,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          egressSpentUsd: run.egressSpentUsd,
          ...(run.failureReason === null ? {} : { failureReason: run.failureReason }),
        },
        outcome: {
          runId: outcome.runId,
          terminal: { valueUsd: outcome.terminalValueUsd, detail: outcome.terminalDetail as Json },
          deltaVsDoNothingUsd: outcome.deltaVsDoNothingUsd,
          deltaVsPeerMedianUsd: outcome.deltaVsPeerMedianUsd,
          maxDrawdownUsd: outcome.maxDrawdownUsd,
          actionCount: outcome.actionCount,
        } as OutcomeRecord,
        replayHash: outcome.replayHash,
        agentName: c?.name ?? null,
        category: (c?.category ?? 'other') as AgentCategory,
        actions: actions.get(run.id) ?? [],
      };
    });
  }

  // --------------------------------------------------------------- outcomes

  async putOutcome(outcome: OutcomeRecord, replayHash: string): Promise<void> {
    await this.db
      .insert(schema.outcomeRecords)
      .values({
        runId: outcome.runId,
        terminalValueUsd: outcome.terminal.valueUsd,
        terminalDetail: outcome.terminal.detail,
        deltaVsDoNothingUsd: outcome.deltaVsDoNothingUsd,
        deltaVsPeerMedianUsd: outcome.deltaVsPeerMedianUsd,
        maxDrawdownUsd: outcome.maxDrawdownUsd,
        actionCount: outcome.actionCount,
        replayHash,
      })
      .onConflictDoUpdate({
        target: schema.outcomeRecords.runId,
        set: {
          terminalValueUsd: outcome.terminal.valueUsd,
          terminalDetail: outcome.terminal.detail,
          deltaVsDoNothingUsd: outcome.deltaVsDoNothingUsd,
          deltaVsPeerMedianUsd: outcome.deltaVsPeerMedianUsd,
          maxDrawdownUsd: outcome.maxDrawdownUsd,
          actionCount: outcome.actionCount,
          replayHash,
        },
      });
  }

  async outcomesFor(agent: AgentId, limit = 20): Promise<readonly OutcomeRecord[]> {
    const rows = await this.db
      .select({ o: schema.outcomeRecords })
      .from(schema.outcomeRecords)
      .innerJoin(schema.shadowRuns, eq(schema.shadowRuns.id, schema.outcomeRecords.runId))
      .innerJoin(schema.agents, eq(schema.agents.id, schema.shadowRuns.agentId))
      .where(agentMatches(agent))
      .orderBy(desc(schema.shadowRuns.finishedAt))
      .limit(limit);

    return rows.map(({ o }) => ({
      runId: o.runId,
      terminal: {
        valueUsd: o.terminalValueUsd,
        detail: o.terminalDetail as TerminalState['detail'],
      },
      deltaVsDoNothingUsd: o.deltaVsDoNothingUsd,
      deltaVsPeerMedianUsd: o.deltaVsPeerMedianUsd,
      maxDrawdownUsd: o.maxDrawdownUsd,
      actionCount: o.actionCount,
    }));
  }

  // ----------------------------------------------------------------- scores

  async putScore(score: Score): Promise<void> {
    const agentUuid = await this.#agentUuid(score.agent);
    await this.db
      .insert(schema.scores)
      .values({
        agentId: agentUuid,
        category: score.category,
        basis: score.basis,
        windowStart: score.window.start,
        windowEnd: score.window.end,
        sampleSize: score.sampleSize,
        baseline: score.baseline as unknown as Json,
        normalized: score.normalized,
        metric: score.metric as unknown as Json,
      })
      .onConflictDoUpdate({
        target: [
          schema.scores.agentId,
          schema.scores.category,
          schema.scores.basis,
          schema.scores.windowEnd,
        ],
        set: {
          windowStart: score.window.start,
          sampleSize: score.sampleSize,
          baseline: score.baseline as unknown as Json,
          normalized: score.normalized,
          metric: score.metric as unknown as Json,
          computedAt: new Date(),
        },
      });
  }

  /**
   * One query for a whole page, resolved with `DISTINCT ON`.
   *
   * Postgres-specific and worth it: the alternative that works everywhere is a
   * self-join against a grouped subquery, which costs a second pass over the
   * same rows to express "the newest score per agent" - a sort the index
   * already gives us.
   */
  async latestScores(
    agents: readonly AgentId[],
    basis: ScoreBasis,
  ): Promise<ReadonlyMap<string, Score>> {
    if (agents.length === 0) return new Map();

    const rows = await this.db
      .select({ s: schema.scores, chain: schema.agents.chain, tokenId: schema.agents.tokenId })
      .from(schema.scores)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.scores.agentId))
      .where(and(eq(schema.scores.basis, basis), anyOfAgents(agents)))
      .orderBy(schema.scores.agentId, desc(schema.scores.windowEnd));

    const out = new Map<string, Score>();
    for (const { s, chain, tokenId } of rows) {
      const id: AgentId = { chain: chainOf(chain), tokenId: toBigInt(tokenId) };
      const key = agentKey(id);
      // Ordered newest-first per agent, so the first row wins and later ones
      // are older windows for the same agent.
      if (!out.has(key)) out.set(key, toScore(s, id));
    }
    return out;
  }

  async latestScore(agent: AgentId, basis: ScoreBasis): Promise<Score | null> {
    return (await this.latestScores([agent], basis)).get(agentKey(agent)) ?? null;
  }

  async topByCategory(
    category: AgentCategory,
    basis: ScoreBasis,
    limit: number,
  ): Promise<readonly Score[]> {
    const rows = await this.db
      .select({ s: schema.scores, chain: schema.agents.chain, tokenId: schema.agents.tokenId })
      .from(schema.scores)
      .innerJoin(schema.agents, eq(schema.agents.id, schema.scores.agentId))
      .where(and(eq(schema.scores.category, category), eq(schema.scores.basis, basis)))
      .orderBy(desc(schema.scores.normalized))
      .limit(limit);

    return rows.map(({ s, chain, tokenId }) =>
      toScore(s, { chain: chainOf(chain), tokenId: toBigInt(tokenId) }),
    );
  }

  // ------------------------------------------------------------------ stats

  /**
   * Append a measurement, at most one per hour per chain.
   *
   * The indexer ticks every thirty seconds, and appending on every tick would
   * fill the table with 2,880 rows a day - so a chart of the last ninety points
   * would cover forty-five minutes, which is not the question the registry
   * health page asks. Catalog density moves on the scale of days. Throttling
   * here rather than at the call site means every caller gets the same cadence
   * without having to know about it.
   */
  async recordStats(stats: CatalogStats): Promise<void> {
    const cutoff = new Date(stats.computedAt.getTime() - 60 * 60_000);
    const recent = await this.db
      .select({ id: schema.catalogStatsHistory.id })
      .from(schema.catalogStatsHistory)
      .where(
        and(
          eq(schema.catalogStatsHistory.chain, stats.chain),
          gt(schema.catalogStatsHistory.computedAt, cutoff),
        ),
      )
      .limit(1);
    if (recent.length > 0) return;

    await this.db.insert(schema.catalogStatsHistory).values({
      chain: stats.chain,
      registered: stats.registered,
      withResolvableCard: stats.withResolvableCard,
      verifiedLive: stats.verifiedLive,
      computedAt: stats.computedAt,
    });
  }

  /** Oldest first, so a caller can plot the array without reversing it. */
  async statsHistory(chain: ChainName, limit = 90): Promise<readonly CatalogStats[]> {
    const rows = await this.db
      .select()
      .from(schema.catalogStatsHistory)
      .where(eq(schema.catalogStatsHistory.chain, chain))
      .orderBy(desc(schema.catalogStatsHistory.computedAt))
      .limit(limit);

    return rows
      .map((r) => ({
        chain: chainOf(r.chain),
        registered: r.registered,
        withResolvableCard: r.withResolvableCard,
        verifiedLive: r.verifiedLive,
        computedAt: r.computedAt,
      }))
      .reverse();
  }

  async recordCrossReference(chain: ChainName, summary: AgreementSummary): Promise<void> {
    await this.db.insert(schema.crossRefSummaries).values({
      chain,
      source: summary.source,
      status: summary.status,
      checked: summary.checked,
      confirmed: summary.confirmed,
      notFound: summary.notFound,
      agreementBps: summary.agreementBps,
      computedAt: new Date(),
    });
  }

  /** Null before the first run: "not checked yet" is not "0% agreement". */
  async latestCrossReference(chain: ChainName): Promise<AgreementSummary | null> {
    const rows = await this.db
      .select()
      .from(schema.crossRefSummaries)
      .where(eq(schema.crossRefSummaries.chain, chain))
      .orderBy(desc(schema.crossRefSummaries.computedAt))
      .limit(1);
    const r = rows[0];
    return r === undefined
      ? null
      : {
          source: r.source,
          status: r.status as AgreementSummary['status'],
          checked: r.checked,
          confirmed: r.confirmed,
          notFound: r.notFound,
          agreementBps: r.agreementBps,
        };
  }

  async #agentUuid(agent: AgentId): Promise<string> {
    const rows = await this.db
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(agentMatches(agent))
      .limit(1);
    const row = rows[0];
    if (row === undefined) {
      throw new BenchError(
        'NOT_FOUND',
        `agent ${agentKey(agent)} is not indexed; index it before recording evidence`,
      );
    }
    return row.id;
  }
}

/**
 * Validate a jsonb blob before it becomes a domain value.
 *
 * The decision trace is verified on read because tampering with it is the
 * attack it exists to detect. These columns were trusted instead - cast
 * straight through - so a malformed `metric` or `baseline` row propagated into
 * scoring and rendering silently. Anyone with write access to the database, or
 * one bad migration, and the catalog starts publishing nonsense with a
 * confident face.
 */
function validMetric(v: unknown): v is CategoryMetric {
  if (v === null || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  return (
    kind === 'rebalancing' ||
    kind === 'yield' ||
    kind === 'grid' ||
    kind === 'monitoring' ||
    kind === 'health-factor'
  );
}

function validBaseline(v: unknown): v is Baseline {
  if (v === null || typeof v !== 'object') return false;
  const kind = (v as { kind?: unknown }).kind;
  return kind === 'do-nothing' || kind === 'peer-median' || kind === 'naive-threshold';
}

function toScore(s: typeof schema.scores.$inferSelect, agent: AgentId): Score {
  if (!validMetric(s.metric)) {
    throw new BenchError(
      'INVALID_AGENT_CARD',
      `score for ${agentKey(agent)} has an unrecognised metric shape; refusing to publish it`,
    );
  }
  if (!validBaseline(s.baseline)) {
    throw new BenchError(
      'INVALID_AGENT_CARD',
      `score for ${agentKey(agent)} has an unrecognised baseline; refusing to publish it`,
    );
  }
  return {
    agent,
    category: s.category as AgentCategory,
    basis: s.basis as ScoreBasis,
    window: { start: s.windowStart, end: s.windowEnd },
    sampleSize: s.sampleSize,
    baseline: s.baseline,
    normalized: s.normalized,
    metric: s.metric,
  };
}

/** `capital` carries a bigint, so the params blob needs an explicit codec like the mandate's. */
const encPosition = (p: PositionTemplate): Json => ({
  label: p.label,
  params: Object.fromEntries(
    Object.entries(p.params).map(([k, v]) => [
      k,
      typeof v === 'bigint' ? { $bigint: v.toString() } : v,
    ]),
  ),
  capital: {
    token: p.capital.token,
    symbol: p.capital.symbol,
    decimals: p.capital.decimals,
    amount: p.capital.amount.toString(),
  },
});

const decPosition = (kind: string, j: Json): PositionTemplate => {
  const cap = j['capital'] as Json;
  const raw = (j['params'] ?? {}) as Record<string, unknown>;
  return {
    kind: kind as PositionTemplate['kind'],
    label: j['label'] as string,
    params: Object.fromEntries(
      Object.entries(raw).map(([k, v]) => [
        k,
        typeof v === 'object' && v !== null && '$bigint' in v
          ? BigInt((v as { $bigint: string }).$bigint)
          : (v as string | number),
      ]),
    ),
    capital: {
      token: cap['token'] as PositionTemplate['capital']['token'],
      symbol: cap['symbol'] as string,
      decimals: cap['decimals'] as number,
      amount: BigInt(cap['amount'] as string),
    },
  };
};

const agentMatches = (id: AgentId) =>
  and(eq(schema.agents.chain, id.chain), eq(schema.agents.tokenId, id.tokenId.toString()));

/**
 * `(chain, token_id) IN (...)` expressed as an OR of pairs.
 *
 * A tuple `IN` would be tidier, but agents are keyed by two columns of
 * different types and drizzle's `inArray` takes one. Kept explicit rather than
 * hand-written SQL so the parameters stay bound.
 */
function anyOfAgents(agents: readonly AgentId[]) {
  const chains = [...new Set(agents.map((a) => a.chain))];
  const tokens = [...new Set(agents.map((a) => a.tokenId.toString()))];

  // A row-value IN, not an OR of pairs. The OR form worked but produced one
  // clause per agent - two hundred on a full catalog page - which Postgres
  // plans poorly and which grows with the catalog the product is selling the
  // size of. The two `inArray` terms stay because together they are the unique
  // index `(chain, token_id)`, so the planner can use it before the row-value
  // filter narrows to the exact pairs.
  const pairs = sql.join(
    agents.map((a) => sql`(${a.chain}, ${a.tokenId.toString()})`),
    sql`, `,
  );

  return and(
    inArray(schema.agents.chain, chains),
    inArray(schema.agents.tokenId, tokens),
    sql`(${schema.agents.chain}, ${schema.agents.tokenId}) in (${pairs})`,
  );
}
