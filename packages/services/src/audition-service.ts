import {
  isVerifiedLive,
  type AuditionStore,
  type AuditionWindow,
  type CatalogRepository,
  type ChainName,
  type ForkProvider,
  type PositionTemplate,
  type ShadowAgent,
  type ShadowRun,
} from '@bench/core';
import { AuditionRunner } from './audition.js';

/**
 * Runs auditions and writes down what happened - ARCHITECTURE.md 3.3.
 *
 * The missing link between the runner and the catalog. `AuditionRunner`
 * produces an `AuditionReport` and forgets it; nothing persisted runs or
 * outcomes, so `shadow_runs`, `outcome_records` and `scores` could only ever
 * hold seed data and no agent in the real catalog could be hired - Bench
 * refuses to hire an agent with no audition record, which made the product's
 * central journey unreachable in production.
 *
 * Two properties worth stating:
 *
 * **Only verified-live agents are auditioned.** An endpoint that does not
 * answer cannot be driven, and spending a forked chain on it teaches nothing.
 *
 * **A failed audition is recorded, not discarded.** An agent that 404s the task
 * or times out gets a `failed` run with the reason. That is the finding, and
 * dropping it would quietly flatter the catalog.
 */

export interface AuditionServiceOptions {
  readonly chain: ChainName;
  readonly archiveRpcUrl: string;
  /** Agents per tick. Forks are heavy; this bounds a tick's cost. */
  readonly batchSize?: number;
  readonly maxConcurrentForks?: number;
  readonly agentTimeoutMs?: number;
  /** Skip agents auditioned more recently than this. */
  readonly reauditionAfterMs?: number;
  readonly clock?: () => Date;
}

export interface AuditionTickResult {
  readonly window: string;
  readonly considered: number;
  readonly auditioned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
}

const DEFAULTS = {
  batchSize: 6,
  maxConcurrentForks: 3,
  agentTimeoutMs: 90_000,
  reauditionAfterMs: 24 * 60 * 60 * 1000,
} as const;

/** Builds the shim that drives a given agent. Injected so tests need no network. */
export type ShadowAgentFactory = (input: {
  readonly agent: import('@bench/core').AgentRecord;
}) => ShadowAgent | null;

export interface AuditionServiceDeps {
  readonly forks: ForkProvider;
  readonly catalog: CatalogRepository;
  readonly store: AuditionStore;
  readonly runner: AuditionRunner;
  readonly agentFor: ShadowAgentFactory;
}

export class AuditionService {
  private readonly now: () => Date;

  constructor(
    private readonly deps: AuditionServiceDeps,
    private readonly opts: AuditionServiceOptions,
  ) {
    this.now = opts.clock ?? (() => new Date());
  }

  /**
   * Audition a batch of verified-live agents against one window and position,
   * then persist every run and outcome.
   *
   * All agents in a tick share one window and one position deliberately: that
   * is what makes the comparison controlled rather than a post-hoc delta over
   * whichever agents happened to run when.
   */
  async tick(window: AuditionWindow, position: PositionTemplate): Promise<AuditionTickResult> {
    const page = await this.deps.catalog.query({
      chain: this.opts.chain,
      verifiedLiveOnly: true,
      limit: (this.opts.batchSize ?? DEFAULTS.batchSize) * 4,
    });

    const now = this.now();
    const cutoff = now.getTime() - (this.opts.reauditionAfterMs ?? DEFAULTS.reauditionAfterMs);
    const budget = this.opts.batchSize ?? DEFAULTS.batchSize;

    const candidates: { agent: (typeof page.entries)[number]['record']; shim: ShadowAgent }[] = [];
    let skipped = 0;

    for (const entry of page.entries) {
      if (candidates.length >= budget) break;
      // The filter already applied this in SQL; re-checking keeps the two
      // definitions honest and costs nothing.
      if (!isVerifiedLive(entry.liveness, now)) {
        skipped += 1;
        continue;
      }
      const recent = await this.deps.store.runsFor(entry.record.id, 1);
      const last = recent[0]?.finishedAt ?? recent[0]?.startedAt ?? null;
      if (last !== null && last.getTime() >= cutoff) {
        skipped += 1;
        continue;
      }
      const shim = this.deps.agentFor({ agent: entry.record });
      if (shim === null) {
        skipped += 1;
        continue;
      }
      candidates.push({ agent: entry.record, shim });
    }

    if (candidates.length === 0) {
      return {
        window: window.id,
        considered: page.entries.length,
        auditioned: 0,
        succeeded: 0,
        failed: 0,
        skipped,
      };
    }

    const report = await this.deps.runner.run({
      window,
      position,
      agents: candidates.map((c) => c.shim),
      archiveRpcUrl: this.opts.archiveRpcUrl,
      maxConcurrentForks: this.opts.maxConcurrentForks ?? DEFAULTS.maxConcurrentForks,
      agentTimeoutMs: this.opts.agentTimeoutMs ?? DEFAULTS.agentTimeoutMs,
    });

    const byShimId = new Map(candidates.map((c) => [c.shim.id, c.agent]));
    let succeeded = 0;
    let failed = 0;

    for (const result of report.results) {
      const agent = byShimId.get(result.agentId);
      if (agent === undefined) continue;

      const runId = `run_${report.replayHash.slice(2, 14)}_${agent.id.tokenId.toString()}`;
      const run: ShadowRun = {
        id: runId,
        agent: agent.id,
        window,
        position,
        status: result.failed ? 'failed' : 'complete',
        startedAt: now,
        finishedAt: this.now(),
        egressSpentUsd: result.egressSpentUsd,
        ...(result.failureReason === undefined ? {} : { failureReason: result.failureReason }),
      };

      // Run first, then outcome: outcome_records references shadow_runs, and
      // writing them the other way round would fail the foreign key.
      await this.deps.store.putRun(run, result.actions);
      await this.deps.store.putOutcome(
        {
          runId,
          terminal: result.terminal,
          deltaVsDoNothingUsd: result.deltaVsDoNothingUsd,
          deltaVsPeerMedianUsd:
            report.peerMedianUsd === null ? null : result.terminal.valueUsd - report.peerMedianUsd,
          maxDrawdownUsd: Math.max(0, result.opened.valueUsd - result.terminal.valueUsd),
          actionCount: result.actions.length,
        },
        report.replayHash,
      );

      if (result.failed) failed += 1;
      else succeeded += 1;
    }

    return {
      window: window.id,
      considered: page.entries.length,
      auditioned: report.results.length,
      succeeded,
      failed,
      skipped,
    };
  }
}
