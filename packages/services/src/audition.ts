import {
  classifyAuditionFailure,
  type AuditionOutcomeKind,
  BenchError,
  replayHash,
  redactError,
  type AuditionWindow,
  type EgressGuard,
  type ForkProvider,
  type MeteredFetch,
  type ShadowAgent,
  type Hex,
  type InterceptedAction,
  type PositionTemplate,
  type TerminalState,
} from '@bench/core';
import { mapLimit } from './concurrency.js';

// The port lives in core so the A2A adapter can implement it without adapters
// depending on services.
export type { MeteredFetch, ShadowAgent, ShadowAgentContext } from '@bench/core';

/**
 * The audition runner — ARCHITECTURE.md 2.
 *
 * Runs N agents against the *same* position over the *same* window, each in
 * its own fork, plus a do-nothing baseline. That is what makes the comparison
 * controlled rather than a post-hoc delta over whichever jobs happened to
 * settle: every agent saw identical starting state, so the difference between
 * them is the agent.
 *
 * Every result carries the replay hash of its window, so a third party can
 * re-run it and check the arithmetic.
 */

export interface AuditionRequest {
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
  readonly agents: readonly ShadowAgent[];
  readonly archiveRpcUrl: string;
  /** Forks are heavy. Bound them or a large catalog exhausts the machine. */
  readonly maxConcurrentForks?: number;
  /** Per-run wall-clock ceiling. An agent that hangs must not hang the batch. */
  readonly agentTimeoutMs?: number;
}

export interface AuditionResult {
  readonly agentId: string;
  readonly agentName: string;
  readonly opened: TerminalState;
  readonly terminal: TerminalState;
  readonly actions: readonly InterceptedAction[];
  readonly deltaVsDoNothingUsd: number;
  readonly replayHash: Hex;
  readonly failed: boolean;
  readonly failureReason?: string;
  readonly failureKind?: AuditionOutcomeKind;
  /** Real money this agent spent reaching the network during its audition. */
  readonly egressSpentUsd: number;
  /**
   * Gas the agent's transactions burned, valued in USD.
   *
   * The real cost of running an agent, and the number its advantage has to
   * beat. `egressSpentUsd` alone was reported as "cost" and is zero for every
   * remote agent - the shim calls the endpoint directly rather than through
   * the meter - so the required with-agent/without-agent cost comparison was
   * being made against zero.
   */
  readonly gasSpentUsd: number;
  /**
   * Worst peak-to-trough decline observed during the run, in USD.
   *
   * Sampled after every transaction rather than derived from the endpoints, so
   * a position that dipped and recovered is not reported as having been calm.
   */
  readonly maxDrawdownUsd: number;
  /** Measured around this agent's run alone, not the batch it was part of. */
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

export interface AuditionReport {
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
  /** The counterfactual where nobody acts. Every delta is measured from here. */
  readonly doNothing: TerminalState;
  readonly results: readonly AuditionResult[];
  readonly replayHash: Hex;
  /** Median terminal value across agents that completed — the peer baseline. */
  readonly peerMedianUsd: number | null;
}

export interface AuditionRunnerDeps {
  readonly forks: ForkProvider;
  /**
   * Absent means the agent gets no network at all, not unmetered network.
   *
   * Deny-by-default is the only safe reading of a missing budget: the
   * alternative is that forgetting to configure a guard silently grants
   * unlimited billable egress, which is precisely the failure the guard exists
   * to prevent.
   */
  readonly egress?: EgressGuard;
  /** Seam for tests. Defaults to global fetch. */
  readonly httpFetch?: typeof fetch;
}

export class AuditionRunner {
  constructor(private readonly deps: AuditionRunnerDeps) {}

  async run(req: AuditionRequest): Promise<AuditionReport> {
    if (req.agents.length === 0) {
      throw new BenchError('NOT_FOUND', 'an audition needs at least one agent');
    }

    const hash = replayHash(req.window);

    // The baseline is a full run with no agent attached: same fork, same
    // seeding, nobody acting. Computing it any other way would make it a
    // different measurement from the ones it is compared against.
    const doNothing = await this.#baseline(req);

    const results = await mapLimit(req.agents, req.maxConcurrentForks ?? 4, async (agent) =>
      this.#runOne(req, agent, doNothing, hash),
    );

    const completed = results
      .filter((r) => !r.failed)
      .map((r) => r.terminal.valueUsd)
      .sort((a, b) => a - b);
    const peerMedianUsd =
      completed.length === 0
        ? null
        : completed.length % 2 === 1
          ? completed[(completed.length - 1) / 2]!
          : (completed[completed.length / 2 - 1]! + completed[completed.length / 2]!) / 2;

    return {
      window: req.window,
      position: req.position,
      doNothing,
      results,
      replayHash: hash,
      peerMedianUsd,
    };
  }

  /**
   * The agent's network access, bound to one run.
   *
   * Refusals are thrown rather than returned. An agent that treats a refused
   * data call as an empty response would trade on a silence it mistook for a
   * fact, and the audition would score that as a decision the agent made rather
   * than as the guard stopping it.
   */
  #meteredFetch(runId: string): MeteredFetch {
    const guard = this.deps.egress;
    const http = this.deps.httpFetch ?? fetch;

    return async (url, init) => {
      if (guard === undefined) {
        throw new BenchError(
          'EGRESS_BUDGET_EXCEEDED',
          `no egress guard is configured, so ${url} is refused; auditions run without network rather than without a budget`,
        );
      }

      const estimate = init?.estimatedCostUsd ?? 0;
      const host = new URL(url).host;
      const decision = await guard.check(runId, host, estimate);
      if (!decision.allowed) {
        throw new BenchError(
          'EGRESS_BUDGET_EXCEEDED',
          `refused ${url}: ${decision.reason ?? 'not permitted'}`,
        );
      }

      const { estimatedCostUsd: _cost, ...request } = init ?? {};
      try {
        return await http(url, request);
      } finally {
        // Recorded even when the request threw: a call that was made and then
        // failed has usually still been billed.
        await guard.record(runId, estimate);
      }
    };
  }

  async #baseline(req: AuditionRequest): Promise<TerminalState> {
    const fork = await this.deps.forks.spawn({
      window: req.window,
      archiveRpcUrl: req.archiveRpcUrl,
    });
    try {
      await fork.seedPosition(req.position);
      return await fork.terminalState(req.position);
    } finally {
      await fork.destroy();
    }
  }

  async #runOne(
    req: AuditionRequest,
    agent: ShadowAgent,
    doNothing: TerminalState,
    hash: Hex,
  ): Promise<AuditionResult> {
    const fork = await this.deps.forks.spawn({
      window: req.window,
      archiveRpcUrl: req.archiveRpcUrl,
    });
    const actions: InterceptedAction[] = [];

    /**
     * True peak-to-trough across the run, not the net change.
     *
     * `maxDrawdownUsd` used to be computed as `opened - terminal`, which is the
     * net decline: an agent that took the position down 50% and recovered
     * recorded a drawdown of zero, and the number was rendered as "Max
     * drawdown" to judges who trade for a living. Sampling after each action
     * is what makes it the quantity its name claims - and each sample is one
     * read against a local anvil, so the cost is negligible next to the
     * transaction that triggered it.
     */
    let peakUsd = 0;
    let troughGapUsd = 0;
    let sampling: Promise<void> = Promise.resolve();
    const sample = (): void => {
      sampling = sampling.then(async () => {
        try {
          const now = await fork.terminalState(req.position);
          if (now.valueUsd > peakUsd) peakUsd = now.valueUsd;
          const gap = peakUsd - now.valueUsd;
          if (gap > troughGapUsd) troughGapUsd = gap;
        } catch {
          // A read that fails mid-run must not fail the audition. The samples
          // that did land still bound the drawdown from below.
        }
      });
    };

    try {
      fork.onAction((a) => {
        actions.push(a);
        sample();
      });
      const seeded = await fork.seedPosition(req.position);
      peakUsd = seeded.openedAt.valueUsd;

      let failed = false;
      let failureReason: string | undefined;
      let failureKind: AuditionOutcomeKind | undefined;

      // Scoped to this agent's run, so one agent cannot spend another's budget
      // and the recorded total is attributable.
      const runId = `${hash}:${agent.id}`;

      // Measured around this agent alone. The audition service used to stamp
      // one `startedAt` before the whole batch and one `finishedAt` after it,
      // so six agents each reported the batch's wall-clock as their own time -
      // and time is one of the three dimensions the TermiX report is required
      // to compare.
      const startedAt = new Date();

      try {
        await withTimeout(
          agent.run({
            rpcUrl: fork.rpcUrl,
            controller: seeded.controller,
            window: req.window,
            position: req.position,
            fetch: this.#meteredFetch(runId),
          }),
          req.agentTimeoutMs ?? 120_000,
          `agent ${agent.id} exceeded its audition timeout`,
        );
      } catch (err) {
        // An agent that throws still has a record: whatever it did before
        // failing is real behaviour, and the failure itself is a finding.
        failed = true;
        // Stored on the run and shown on the public agent page. The message
        // can carry the fork's own RPC URL or an endpoint's error body.
        failureReason = redactError(err);
        // Classified here, where the error object still exists. Reading the
        // kind back out of the stored sentence would reclassify history every
        // time that sentence was reworded.
        failureKind = classifyAuditionFailure(err);
      }

      const finishedAt = new Date();
      // Let any sampling started by a late action finish before the verdict.
      await sampling;
      const terminal = await fork.terminalState(req.position);
      if (terminal.valueUsd > peakUsd) peakUsd = terminal.valueUsd;
      if (peakUsd - terminal.valueUsd > troughGapUsd) troughGapUsd = peakUsd - terminal.valueUsd;

      /**
       * Gas, priced in the same unit of account as the position.
       *
       * `nativePriceUsd` is pinned on the window rather than fetched, which is
       * what makes two agents in the same audition comparable: a price that
       * moved between two runs would show up as one agent outperforming the
       * other. Missing it yields zero rather than a guess.
       */
      const gasUsed = actions.reduce((a, x) => a + x.simulated.gasUsed, 0n);
      const declaredPrice = req.position.params['nativePriceUsd'];
      const nativePriceUsd = typeof declaredPrice === 'number' ? declaredPrice : 0;
      const gasPriceWei = gasUsed === 0n ? 0n : await fork.gasPriceWei();
      const gasSpentUsd = (Number(gasUsed * gasPriceWei) / 1e18) * nativePriceUsd;

      return {
        agentId: agent.id,
        agentName: agent.name,
        opened: seeded.openedAt,
        terminal,
        actions,
        deltaVsDoNothingUsd: terminal.valueUsd - doNothing.valueUsd,
        maxDrawdownUsd: troughGapUsd,
        startedAt,
        finishedAt,
        replayHash: hash,
        failed,
        ...(failureReason === undefined ? {} : { failureReason }),
        ...(failureKind === undefined ? {} : { failureKind }),
        egressSpentUsd: this.deps.egress === undefined ? 0 : await this.deps.egress.spent(runId),
        gasSpentUsd,
      };
    } finally {
      await fork.destroy();
    }
  }
}

async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BenchError('FORK_UNAVAILABLE', message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
