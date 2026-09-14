import type { AgentEndpoint, AgentId, AgentRecord, ProbeResult } from '../types/agent.js';
import type { AgentCategory } from '../types/agent.js';
import type { CatalogPage, CatalogQuery, CatalogStats, LivenessSummary } from '../types/catalog.js';
import type { ChainName, Hex } from '../types/primitives.js';

/** One endpoint owed a probe, with the agent it belongs to. */
export interface ProbeTarget {
  readonly agent: AgentId;
  readonly endpoint: AgentEndpoint;
  readonly lastProbedAt: Date | null;
}

/**
 * Where the indexer resumes from. Persisted per chain so a restart re-reads a
 * bounded overlap instead of the registry from genesis — and so an operator
 * can rewind by editing one row when an event decode turns out to be wrong.
 */
export interface IndexerCheckpoint {
  readonly chain: ChainName;
  readonly lastBlock: bigint;
  /**
   * Highest token id walked, for enumeration-based discovery.
   *
   * Separate from `lastBlock` because the two resume different things: a block
   * cursor resumes a log scan, a token cursor resumes an id walk, and a
   * deployment can use either. Null means no walk has run.
   */
  readonly lastTokenId: bigint | null;
  readonly updatedAt: Date;
}

/**
 * Persistence for the catalog. A port rather than direct Drizzle calls so the
 * indexer and prober can be tested against an in-memory implementation with no
 * Postgres, and so the web app reads through the same contract the worker
 * writes through.
 */
export interface CatalogRepository {
  /** Idempotent by (chain, tokenId): re-indexing a block range is safe. */
  upsertAgents(records: readonly AgentRecord[]): Promise<number>;
  getAgent(id: AgentId): Promise<AgentRecord | null>;

  recordProbe(result: ProbeResult): Promise<void>;
  /** Folded over the retained probe history for this agent. */
  liveness(agent: AgentId): Promise<LivenessSummary>;
  /**
   * Least-recently-probed first, so a large catalog cycles fairly.
   *
   * `bootstrap` exists because a verdict needs `VERIFIED_LIVE.minProbeCount`
   * probes and `staleAfterMs` is an hour. Without it a fresh deployment gives
   * every endpoint one probe in the first few minutes, then goes quiet for an
   * hour, and cannot call a single agent verified live for two hours - during
   * which the site reports that 0% of the registry is real. An endpoint that
   * does not yet have enough probes to be judged is due again after
   * `afterMs` instead, and settles to the hourly cadence once it does.
   */
  dueForProbe(
    limit: number,
    staleAfterMs: number,
    bootstrap?: { readonly afterMs: number; readonly untilProbeCount: number },
    /**
     * How long to leave an endpoint that has never once answered.
     *
     * Probing every endpoint on the same schedule is affordable on a registry
     * of 2,400 and is not on one of 343,000, where about 36,000 declare an
     * endpoint and roughly 1,200 of those ever respond. On the hourly cadence
     * that is 864,000 probes a day to learn nothing 97% of the time - and
     * worse than wasteful, because a prober that cannot get round the set in
     * time drops agents out of "verified live" for being unreachable *by
     * Bench*, which is a fact about Bench published as a fact about them.
     *
     * So an endpoint with no reachable probe in its retained history is
     * demoted to this interval instead. It costs a dead endpoint a couple of
     * probes a day, and the moment one answers it is promoted back by the same
     * rule that demoted it. Omitted, nothing is demoted and every endpoint
     * keeps the single cadence.
     */
    coldAfterMs?: number,
  ): Promise<readonly ProbeTarget[]>;
  /**
   * How many bytes this database occupies.
   *
   * On the port because the worker has to decide whether to keep indexing, and
   * "is there room" is a question about the store rather than about a agent.
   */
  sizeBytes(): Promise<number>;
  /**
   * Highest token id indexed on this chain, or null before the first tick.
   *
   * Not the same question as "how many agents are indexed", and the difference
   * is the whole honesty of the front page. Bench indexes the registry newest
   * first and cannot hold all of it, so the count of rows is how far it has
   * got; the highest id it has seen is how big the registry is. Labelling the
   * first as the second said "4,019 agents registered on BSC" while the
   * registry held 346,444 - a number that undersells the problem the project
   * exists to measure, and is simply false.
   */
  highestTokenId(chain: ChainName): Promise<bigint | null>;
  /**
   * Agents Bench has tested: probed enough times to have reached a verdict.
   *
   * The denominator for the live share, and not the same thing as the number
   * indexed. A verdict needs three probes inside six hours, the prober reaches
   * six hundred endpoints a tick, and the indexer had taken the catalog to
   * 196,749 agents - so the front page divided 23 by 196,749 and published
   * "0.0% of what is indexed", which reads as a finding about the registry and
   * was a statement about how far a queue had got.
   *
   * Ever tested, not recently tested, and that distinction is the whole
   * correctness of the number. Requiring recency here hands the denominator to
   * the prober's scheduling: it refreshes endpoints that have conformed ahead
   * of everything else, so live verdicts stay current while dead ones age out
   * and leave the set. Measured, that overstated the share fivefold - 0.9%
   * published against 0.17% from sampling the same band. Nothing leaves this
   * set, so no ordering decision can move it.
   */
  verdictCount(chain: ChainName): Promise<number>;
  /** Probes not yet covered by an onchain anchor, oldest first. */
  unanchoredProbes(limit: number): Promise<readonly ProbeResult[]>;
  markProbesAnchored(upTo: Date, digest: Hex, txHash: Hex): Promise<number>;
  /** Most recent anchored digest, or null before the first anchor. */
  lastAnchoredDigest(): Promise<Hex | null>;

  query(q: CatalogQuery): Promise<CatalogPage>;
  stats(chain: ChainName): Promise<CatalogStats>;
  /**
   * How many agents are in each category, over the whole catalog.
   *
   * Counted in SQL rather than by tallying a page. The catalog page loaded 200
   * rows and filtered them in the browser, so the category tabs reported the
   * composition of that page: a judge clicking "Rebalancing" saw three agents
   * and had no way to tell whether that was the catalog or the slice. Agent
   * Diversity is one of three main-track criteria, so the number behind it has
   * to be the real one.
   */
  categoryCounts(
    chain: ChainName,
    opts?: { readonly verifiedLiveOnly?: boolean },
  ): Promise<Readonly<Record<AgentCategory, number>>>;

  checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null>;
  setCheckpoint(chain: ChainName, lastBlock: bigint): Promise<void>;
  /** Resume point for `enumerateAgents`. Independent of the block cursor. */
  setTokenCursor(chain: ChainName, lastTokenId: bigint): Promise<void>;
}
