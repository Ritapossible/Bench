import type { AgentCategory, AgentId } from '../types/agent.js';
import type { CatalogStats } from '../types/catalog.js';
import type { AgreementSummary } from './crossref.js';
import type { InterceptedAction, OutcomeRecord, ShadowRun } from '../types/audition.js';
import type { Score, ScoreBasis } from '../types/score.js';

/**
 * Where audition evidence lives - ARCHITECTURE.md 3.3.
 *
 * Separate from `CatalogRepository` because the two answer different questions
 * and fail independently: the catalog answers "does this agent exist and is it
 * up", this answers "what did it do and how well". An indexer outage should not
 * take scores with it, and a scoring bug should not blank the catalog.
 *
 * Reads are batched by design. Every catalog page needs a score for each row,
 * and a per-row query is a page that gets slower the more agents Bench indexes,
 * which is the wrong direction for a marketplace whose pitch is breadth.
 */
export interface AuditionStore {
  putRun(run: ShadowRun, actions: readonly InterceptedAction[]): Promise<void>;
  runsFor(agent: AgentId, limit?: number): Promise<readonly ShadowRun[]>;
  /**
   * The intercepted actions of the given runs, grouped by run id.
   *
   * `putRun` had no counterpart, so every action an audition recorded was
   * written and never read. That was not merely dead storage: the behavioural
   * envelope is derived from what an agent did while auditioning, and with no
   * way to read those actions back the hire path invented them - identical
   * hardcoded values for every agent, which made the envelope describe no agent
   * at all. Batched by run id for the reason stated above: a per-run query
   * turns a hire page into one that slows down as an agent is audited more.
   */
  actionsForRuns(
    runIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly InterceptedAction[]>>;

  putOutcome(outcome: OutcomeRecord, replayHash: string): Promise<void>;
  outcomesFor(agent: AgentId, limit?: number): Promise<readonly OutcomeRecord[]>;

  putScore(score: Score): Promise<void>;
  /**
   * The most recent score per agent, for one basis.
   *
   * Keyed by `chain:tokenId` rather than returned as an array, because the
   * caller has agents with no score and needs to distinguish "not scored yet"
   * from "scored zero" - a marketplace that renders an unscored agent as a
   * zero is lying about it.
   */
  latestScores(agents: readonly AgentId[], basis: ScoreBasis): Promise<ReadonlyMap<string, Score>>;
  latestScore(agent: AgentId, basis: ScoreBasis): Promise<Score | null>;
  /** Best normalized score per category, for the leaderboard. */
  topByCategory(
    category: AgentCategory,
    basis: ScoreBasis,
    limit: number,
  ): Promise<readonly Score[]>;

  /**
   * Append today's catalog density measurement.
   *
   * The registry health dashboard plots this over time, and a line drawn
   * through numbers computed on demand is not a history - it is the same
   * number repeated. Appending on every indexer tick is what makes the trend
   * a claim we can stand behind.
   */
  recordStats(stats: CatalogStats): Promise<void>;

  /**
   * Store the latest corroboration result, computed on a schedule.
   *
   * Cross-referencing costs one upstream call per agent, so it belongs in the
   * worker, not in a page render. `latestCrossReference` returns null before
   * the first run - which the UI must show as "not checked yet" rather than as
   * zero agreement, since those are different claims.
   */
  recordCrossReference(chain: CatalogStats['chain'], summary: AgreementSummary): Promise<void>;
  latestCrossReference(chain: CatalogStats['chain']): Promise<AgreementSummary | null>;
  statsHistory(chain: CatalogStats['chain'], limit?: number): Promise<readonly CatalogStats[]>;
}

/** The map key used by `latestScores`. Stable across both implementations. */
export const agentKey = (a: AgentId): string => `${a.chain}:${a.tokenId.toString()}`;
