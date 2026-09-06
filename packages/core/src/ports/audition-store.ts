import type { AgentCategory, AgentId } from '../types/agent.js';
import type { ChainName } from '../types/primitives.js';
import type { CatalogStats } from '../types/catalog.js';
import type { AgreementSummary } from './crossref.js';
import type { InterceptedAction, OutcomeRecord, ShadowRun } from '../types/audition.js';
import type { Score, ScoreBasis } from '../types/score.js';

/**
 * One completed audition, with the run, its outcome, and what makes it
 * checkable. `actions` is what the agent actually did, which is the "outputs
 * attached" half of the report.
 */
export interface AuditionEvidence {
  readonly run: ShadowRun;
  readonly outcome: OutcomeRecord;
  readonly replayHash: string;
  readonly agentName: string | null;
  readonly category: AgentCategory;
  readonly actions: readonly InterceptedAction[];
}

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

  /**
   * Agents that have at least one recorded outcome, most recently audited
   * first.
   *
   * The scorer used to take the first page of the catalog ordered by token id
   * and ask each row for outcomes. With 2,066 agents registered and a limit of
   * 500, it could only ever score tokens 0-499 - while auditions pick from
   * verified-live agents, which are spread across the whole registry. The one
   * agent that did audition successfully sat at #1581, so a working audition
   * still produced no score and the catalog said "no auditions yet" forever.
   *
   * Scoring is driven by evidence rather than by position in a list, which is
   * also the cheaper query: the agents with outcomes are a tiny fraction of the
   * catalog, and asking the rest is work that can only return nothing.
   */
  agentsWithOutcomes(
    chain: ChainName,
    limit?: number,
  ): Promise<readonly { readonly agent: AgentId; readonly category: AgentCategory }[]>;

  /**
   * Completed auditions with everything needed to reproduce the comparison,
   * newest first.
   *
   * The Agent Advantage Report is a required deliverable: three real tasks run
   * with and without an agent, reporting time, cost and output quality with the
   * outputs attached. An audition already *is* that comparison - the same
   * position, the same window, the agent against a do-nothing baseline - so the
   * report is generated from recorded evidence rather than written by hand.
   * This is the query that makes that possible, and it returns the replay hash
   * so a reader can check the run rather than take the number on trust.
   */
  completedAuditions(chain: ChainName, limit?: number): Promise<readonly AuditionEvidence[]>;
  /**
   * Completed auditions for one window.
   *
   * On-demand reports run every agent against a window keyed by the reader's
   * address, so this is how the page reads back what happened to *their*
   * position rather than to the shared one.
   */
  auditionsForWindow(windowId: string, limit?: number): Promise<readonly AuditionEvidence[]>;

  /**
   * How the runs in one window ended, counted by kind.
   *
   * The report showed "Agents auditioned: 18" over a table of one, because
   * evidence rows only exist for runs that completed and the other seventeen
   * were invisible to the page. Counting them here rather than inferring from
   * the gap: a missing evidence row could equally be an agent that has not run
   * yet, and those are not the same claim.
   */
  outcomeCountsForWindow(windowId: string): Promise<AuditionOutcomeCounts>;

  putOutcome(outcome: OutcomeRecord, replayHash: string): Promise<void>;
  /**
   * Outcomes for an agent, from runs that completed.
   *
   * Runs that failed are excluded, and that is a correctness rule rather than a
   * filter for tidiness. An agent that 404s the audition task, times out, or
   * refuses it still produces an outcome - it moved nothing, so its delta
   * against doing nothing is zero - and scoring that alongside real results
   * presented "could not be driven at all" as "+$0.00, chose not to act". Those
   * are opposite findings, and the kinder one was winning: twenty agents in the
   * live catalog carried a +$0.00 score built entirely on failed auditions.
   *
   * `includeFailed` exists for the agent detail page, which shows every run
   * beside its status and reason and so needs the whole history.
   */
  outcomesFor(
    agent: AgentId,
    limit?: number,
    opts?: { readonly includeFailed?: boolean },
  ): Promise<readonly OutcomeRecord[]>;

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

  /**
   * Withdraw an agent's scores for one basis. Returns how many rows went.
   *
   * A score has to be able to stop being true. `putScore` only ever writes, so
   * when the rules changed to exclude auditions that failed, twenty agents kept
   * showing a published number the scorer would no longer produce - evidence
   * had been withdrawn and the conclusion stayed up. Anything that stops
   * qualifying has to be retracted, not merely left unrefreshed.
   */
  deleteScores(agent: AgentId, basis: ScoreBasis): Promise<number>;

  /**
   * Failed auditions per agent, keyed like `latestScores`.
   *
   * An agent whose every audition failed has no score, and without this it is
   * indistinguishable from one that was never picked up - the catalog showed
   * both as "No auditions yet - queued for audition". They are opposite
   * findings: one is a queue that has not reached the agent, the other is an
   * agent that was reached and could not be driven, which is the more useful
   * result of the two and the one the catalog was hiding.
   *
   * Absent from the map means no failures, not zero failures recorded.
   */
  failedAuditions(agents: readonly AgentId[]): Promise<ReadonlyMap<string, FailedAuditions>>;
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

/** Why an agent has no score despite having been picked up for audition. */
export interface FailedAuditions {
  readonly count: number;
  /** Reason from the most recent failure, verbatim from the run record. */
  readonly lastReason: string | null;
  readonly lastAt: Date | null;
}

/** The map key used by `latestScores`. Stable across both implementations. */
export const agentKey = (a: AgentId): string => `${a.chain}:${a.tokenId.toString()}`;

/** Runs in one window, by how they ended. Absent kinds are zero. */
export interface AuditionOutcomeCounts {
  readonly completed: number;
  readonly declined: number;
  readonly unreachable: number;
  readonly errored: number;
  /** Failed before 0008, so its kind was never recorded. */
  readonly unclassified: number;
}
