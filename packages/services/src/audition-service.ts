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

/** Stable map key for an agent id, which is a pair rather than a scalar. */
const agentKeyOf = (id: { chain: string; tokenId: bigint }): string =>
  `${id.chain}:${id.tokenId.toString()}`;

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
  /**
   * The chain agents are *registered* on, used to select the catalog. Not the
   * chain being forked - that is whatever `archiveRpcUrl` serves, and the two
   * differ on purpose: identity is on testnet, market history is on mainnet.
   */
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
  /** Agents this tick examined. Not the page size - the loop stops at budget. */
  readonly considered: number;
  readonly auditioned: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  /**
   * Why the skipped ones were skipped, grouped by cause.
   *
   * `skipped` alone reports that a tick did nothing without saying whether the
   * catalog is exhausted, the agents cannot be driven, or something is wrong -
   * three situations needing three different responses. A tick reporting
   * "considered 20, auditioned 0, skipped 20" and nothing else took four
   * separate investigations to explain.
   */
  readonly skipReasons: Readonly<Record<string, number>>;
}

/**
 * Why a tick produced no usable audition, in the tick's own numbers.
 *
 * /report used to answer an empty result with "the catalog has none that could
 * be driven right now". Nothing had established that. The web layer sees only
 * that the evidence table is empty for this window; the three situations that
 * produce that - nothing verified live, nothing drivable, everything driven and
 * everything failed - need three different responses, and it was picking one of
 * them and stating it as fact to a reader who had waited for the answer.
 *
 * This is the only place that holds the numbers, so this is where the sentence
 * gets written.
 */
export function describeEmptyTick(r: AuditionTickResult): string {
  if (r.considered === 0) {
    return (
      'no agent in the catalog is verified live on this chain right now, so there was nothing ' +
      'to audition against this position'
    );
  }
  if (r.auditioned === 0) {
    const why = Object.entries(r.skipReasons)
      .sort(([, a], [, b]) => b - a)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(', ');
    return (
      `none of the ${r.considered} verified-live agents could be driven against this position ` +
      `(${why === '' ? 'no reason recorded' : why})`
    );
  }
  return (
    `${r.auditioned} verified-live agents were driven against this position and all ${r.failed} ` +
    'failed to complete a run, so there is no measured outcome to report'
  );
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
  /**
   * @param opts.ignoreRecency Audition every verified-live agent regardless of
   * when it last ran. The 24-hour floor exists to stop the shared window
   * re-auditioning the same agents four times an hour; an on-demand report is
   * a different position that has never been run, and skipping agents as
   * "audited recently" would return an empty report to a reader waiting on it.
   */
  async tick(
    window: AuditionWindow,
    position: PositionTemplate,
    opts: { readonly ignoreRecency?: boolean; readonly batchSize?: number } = {},
  ): Promise<AuditionTickResult> {
    // Per call, so an on-demand report can cover the whole verified-live set
    // rather than the six the shared window is paced at.
    const budget = opts.batchSize ?? this.opts.batchSize ?? DEFAULTS.batchSize;

    const page = await this.deps.catalog.query({
      chain: this.opts.chain,
      verifiedLiveOnly: true,
      limit: budget * 4,
    });

    const now = this.now();
    const cutoff = now.getTime() - (this.opts.reauditionAfterMs ?? DEFAULTS.reauditionAfterMs);

    const candidates: { agent: (typeof page.entries)[number]['record']; shim: ShadowAgent }[] = [];
    let skipped = 0;
    const skipReasons: Record<string, number> = {};
    const skip = (why: string): void => {
      skipped += 1;
      skipReasons[why] = (skipReasons[why] ?? 0) + 1;
    };

    /**
     * Last audition per candidate, in one round rather than one query each.
     *
     * The loop below asked the store per agent, so a tick cost a query per
     * considered agent and got slower as the catalog grew - the wrong
     * direction for the same reason the catalog's own reads are batched.
     */
    const lastRunAt = new Map<string, number>();
    await Promise.all(
      page.entries.map(async (entry) => {
        const recent = await this.deps.store.runsFor(entry.record.id, 1);
        const at = recent[0]?.finishedAt ?? recent[0]?.startedAt ?? null;
        if (at !== null) lastRunAt.set(agentKeyOf(entry.record.id), at.getTime());
      }),
    );

    // Counts agents this tick actually looked at, so `considered` is not a page
    // size. The loop stops at the batch budget, and reporting the whole page as
    // considered left `considered - auditioned - skipped` unexplained - the
    // exact arithmetic the health check uses to decide a queue is failing
    // silently.
    let considered = 0;
    for (const entry of page.entries) {
      if (candidates.length >= budget) break;
      considered += 1;
      // The filter already applied this in SQL; re-checking keeps the two
      // definitions honest and costs nothing.
      if (!isVerifiedLive(entry.liveness, now)) {
        // The SQL filter and this check are meant to agree; if this ever fires
        // in volume, they have drifted and the catalog is showing agents the
        // audition path will not touch.
        skip('not verified live on re-check');
        continue;
      }
      const last =
        opts.ignoreRecency === true ? null : (lastRunAt.get(agentKeyOf(entry.record.id)) ?? null);
      if (last !== null && last >= cutoff) {
        skip('audited recently');
        continue;
      }
      const shim = this.deps.agentFor({ agent: entry.record });
      if (shim === null) {
        skip('no drivable endpoint');
        continue;
      }
      candidates.push({ agent: entry.record, shim });
    }

    if (candidates.length === 0) {
      return {
        window: window.id,
        considered,
        auditioned: 0,
        succeeded: 0,
        failed: 0,
        skipped,
        skipReasons,
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
        // The runner's own measurement of this agent, not the batch's. These
        // were one timestamp taken before the batch and one after it, so every
        // agent in a batch of six reported the same inflated duration - and
        // duration is one of the three dimensions TermiX asks us to compare.
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        egressSpentUsd: result.egressSpentUsd,
        gasSpentUsd: result.gasSpentUsd,
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
          // Sampled peak-to-trough from the runner. This was
          // `opened - terminal`, the net decline, which reported an agent that
          // halved the position and recovered as having no drawdown at all.
          maxDrawdownUsd: result.maxDrawdownUsd,
          actionCount: result.actions.length,
        },
        report.replayHash,
      );

      if (result.failed) failed += 1;
      else succeeded += 1;
    }

    return {
      window: window.id,
      considered,
      auditioned: report.results.length,
      succeeded,
      failed,
      skipped,
      skipReasons,
    };
  }
}
