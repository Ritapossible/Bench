import type { AgentEndpoint, AgentId, AgentRecord, ProbeResult } from '../types/agent.js';
import type {
  CatalogPage,
  CatalogQuery,
  CatalogStats,
  LivenessSummary,
} from '../types/catalog.js';
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
  /** Least-recently-probed first, so a large catalog cycles fairly. */
  dueForProbe(limit: number, staleAfterMs: number): Promise<readonly ProbeTarget[]>;
  /** Probes not yet covered by an onchain anchor, oldest first. */
  unanchoredProbes(limit: number): Promise<readonly ProbeResult[]>;
  markProbesAnchored(upTo: Date, digest: Hex, txHash: Hex): Promise<number>;
  /** Most recent anchored digest, or null before the first anchor. */
  lastAnchoredDigest(): Promise<Hex | null>;

  query(q: CatalogQuery): Promise<CatalogPage>;
  stats(chain: ChainName): Promise<CatalogStats>;

  checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null>;
  setCheckpoint(chain: ChainName, lastBlock: bigint): Promise<void>;
}
