import type {
  AgentCategory,
  AgreementSummary,
  AgentId,
  CatalogEntry,
  CatalogStats,
  InterceptedAction,
  LivePosition,
  OutcomeRecord,
  Score,
  ShadowRun,
} from '@bench/core';
import type { AdvantageReport } from '@bench/services';

/**
 * Everything the web app needs, expressed once.
 *
 * The UI talks to this interface and nothing else. Today it is backed by
 * fixtures (`./fixtures`); when the indexer and shadow engine are serving over
 * HTTP, only `./index.ts` changes. No page, and no component, should ever
 * import a fixture directly.
 */
export interface BenchData {
  /**
   * The Agent Advantage Report, generated from recorded auditions.
   *
   * A required submission deliverable, and one every other entrant will write
   * by hand. Generated because an audition already is the comparison it asks
   * for, and a hand-typed number is one nobody can check.
   */
  advantage(): Promise<AdvantageReport>;
  /** Catalog density - the ~4% claim, computed against what we actually indexed. */
  catalogStats(): Promise<CatalogStats>;
  /** Same measurement over time, for the public registry health dashboard. */
  catalogHistory(): Promise<readonly CatalogStats[]>;
  /**
   * Where the catalog came from.
   *
   * The registry health page contrasts its numbers with the ~4% the ERC-8004
   * study measured, which only means anything if those numbers came from
   * indexing the registry. A curated seed reads as a spectacular finding
   * instead of a demo, so the page has to be able to tell the difference and
   * say so.
   */
  catalogProvenance(): Promise<CatalogProvenance>;
  /**
   * Whether any probe digest has actually been anchored on chain.
   *
   * Read from state, not asserted. Two pages claimed in present tense that
   * probe hashes "are anchored on-chain, so liveness is auditable" while
   * `anchorProbeDigest` threw NOT_IMPLEMENTED and nothing had ever been
   * anchored. Overclaiming auditability is a worse failure here than anywhere
   * else on the site, because auditability is the thing being sold.
   */
  probeAnchoring(): Promise<{ readonly anchored: boolean; readonly latestDigest: string | null }>;
  /**
   * Independent corroboration of what the indexer found. Returns an
   * `unconfigured` status until an 8004scan key is granted - the panel says so
   * rather than disappearing, because "we have not checked" and "there is
   * nothing to check" are different claims.
   */
  crossReference(): Promise<AgreementSummary>;

  listAgents(opts?: {
    readonly verifiedLiveOnly?: boolean;
    readonly category?: AgentCategory;
  }): Promise<readonly AgentSummary[]>;

  getAgent(chain: string, tokenId: string): Promise<AgentDetail | null>;

  /** An audition report against one position, for §3.8's pasted address. */
  reportForAddress(address: string): Promise<AddressReportResult>;
}

/**
 * - `indexed` - the indexer has a checkpoint, so these agents came off chain.
 * - `seeded`  - a database with no checkpoint: written by `npm run db:seed`.
 * - `fixtures` - no database at all.
 */
export type CatalogProvenance = 'indexed' | 'seeded' | 'fixtures';

/** A catalog row: the registry record, its liveness, and its best score. */
export interface AgentSummary {
  readonly entry: CatalogEntry;
  /** Null for agents with no completed auditions - shown, never faked. */
  readonly score: Score | null;
}

export interface AgentDetail extends AgentSummary {
  readonly runs: readonly ShadowRun[];
  readonly outcomes: readonly OutcomeRecord[];
  /**
   * What the agent actually did in each run, keyed by run id.
   *
   * Carried because the behavioural envelope is derived from it. When this was
   * absent the hire path fabricated actions instead - the same hardcoded
   * recipient, selector and value for every agent - so every envelope came out
   * identical and described nothing about the agent it was supposed to bound.
   */
  readonly actionsByRun: ReadonlyMap<string, readonly InterceptedAction[]>;
  /** Realized score, once settled hires exist. Never merged with simulated. */
  readonly realized: Score | null;
}

/** One agent's counterfactual against a specific real position. */
export interface AddressReportLine {
  readonly agent: AgentId;
  readonly name: string;
  readonly category: AgentCategory;
  readonly deltaUsd: number;
  readonly actionCount: number;
  readonly verifiedLive: boolean;
}

/**
 * Three distinct answers, because collapsing them misleads.
 *
 * A malformed address and an address nobody has auditioned against are
 * different facts about the world, and a page that renders both as "not found"
 * tells a user their address is wrong when it is not. Same principle as
 * `crossReference`'s `unconfigured` status: "we have not checked" is a claim in
 * its own right, and it is the honest one to make before the shadow engine has
 * run against a position.
 */
export type AddressReportResult =
  /** Position read, and auditioned against it. Both halves present. */
  | { readonly status: 'ok'; readonly report: AddressReport }
  /**
   * The position is real and was read from chain; no agent has been auditioned
   * against it yet. This is the honest state before the shadow engine can run
   * on demand, and it is worth showing rather than withholding: what you hold
   * is a fact, and it is most of what a reader came to see.
   */
  | { readonly status: 'position-only'; readonly position: LivePosition }
  | { readonly status: 'invalid-address' }
  /** A node was unreachable. Distinct from "you hold nothing". */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface AddressReport {
  /** What the address actually holds, read from chain. Never simulated. */
  readonly position: LivePosition | null;
  readonly address: string;
  readonly positionLabel: string;
  readonly positionValueUsd: number;
  readonly windowLabel: string;
  readonly doNothingUsd: number;
  readonly lines: readonly AddressReportLine[];
  readonly computedAt: Date;
}
