import type {
  AgentCategory,
  AgreementSummary,
  AgentId,
  CatalogEntry,
  CatalogStats,
  OutcomeRecord,
  Score,
  ShadowRun,
} from '@bench/core';

/**
 * Everything the web app needs, expressed once.
 *
 * The UI talks to this interface and nothing else. Today it is backed by
 * fixtures (`./fixtures`); when the indexer and shadow engine are serving over
 * HTTP, only `./index.ts` changes. No page, and no component, should ever
 * import a fixture directly.
 */
export interface BenchData {
  /** Catalog density — the ~4% claim, computed against what we actually indexed. */
  catalogStats(): Promise<CatalogStats>;
  /** Same measurement over time, for the public registry health dashboard. */
  catalogHistory(): Promise<readonly CatalogStats[]>;
  /**
   * Independent corroboration of what the indexer found. Returns an
   * `unconfigured` status until an 8004scan key is granted — the panel says so
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
  reportForAddress(address: string): Promise<AddressReport | null>;
}

/** A catalog row: the registry record, its liveness, and its best score. */
export interface AgentSummary {
  readonly entry: CatalogEntry;
  /** Null for agents with no completed auditions — shown, never faked. */
  readonly score: Score | null;
}

export interface AgentDetail extends AgentSummary {
  readonly runs: readonly ShadowRun[];
  readonly outcomes: readonly OutcomeRecord[];
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

export interface AddressReport {
  readonly address: string;
  readonly positionLabel: string;
  readonly positionValueUsd: number;
  readonly windowLabel: string;
  readonly doNothingUsd: number;
  readonly lines: readonly AddressReportLine[];
  readonly computedAt: Date;
}
