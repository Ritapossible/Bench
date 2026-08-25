import {
  BenchError,
  replayHash,
  type Address,
  type AuditionWindow,
  type EgressGuard,
  type ForkProvider,
  type Hex,
  type InterceptedAction,
  type PositionTemplate,
  type TerminalState,
} from '@bench/core';
import { mapLimit } from './concurrency.js';

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

export interface ShadowAgentContext {
  /** The interceptor's RPC. The agent cannot tell it is not a live node. */
  readonly rpcUrl: string;
  /** The throwaway account holding the mirrored position. */
  readonly controller: Address;
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
}

/**
 * An agent under audition. In production this is a thin shim that hands the
 * RPC endpoint to a real registered agent over A2A/MCP; in tests it is a
 * function. The runner does not care which.
 */
export interface ShadowAgent {
  readonly id: string;
  readonly name: string;
  run(ctx: ShadowAgentContext): Promise<void>;
}

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
  readonly egress?: EgressGuard;
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

    const results = await mapLimit(
      req.agents,
      req.maxConcurrentForks ?? 4,
      async (agent) => this.#runOne(req, agent, doNothing, hash),
    );

    const completed = results.filter((r) => !r.failed).map((r) => r.terminal.valueUsd).sort((a, b) => a - b);
    const peerMedianUsd =
      completed.length === 0
        ? null
        : completed.length % 2 === 1
          ? completed[(completed.length - 1) / 2]!
          : (completed[completed.length / 2 - 1]! + completed[completed.length / 2]!) / 2;

    return { window: req.window, position: req.position, doNothing, results, replayHash: hash, peerMedianUsd };
  }

  async #baseline(req: AuditionRequest): Promise<TerminalState> {
    const fork = await this.deps.forks.spawn({ window: req.window, archiveRpcUrl: req.archiveRpcUrl });
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
    const fork = await this.deps.forks.spawn({ window: req.window, archiveRpcUrl: req.archiveRpcUrl });
    const actions: InterceptedAction[] = [];

    try {
      fork.onAction((a) => actions.push(a));
      const seeded = await fork.seedPosition(req.position);

      let failed = false;
      let failureReason: string | undefined;

      try {
        await withTimeout(
          agent.run({
            rpcUrl: fork.rpcUrl,
            controller: seeded.controller,
            window: req.window,
            position: req.position,
          }),
          req.agentTimeoutMs ?? 120_000,
          `agent ${agent.id} exceeded its audition timeout`,
        );
      } catch (err) {
        // An agent that throws still has a record: whatever it did before
        // failing is real behaviour, and the failure itself is a finding.
        failed = true;
        failureReason = err instanceof Error ? err.message : String(err);
      }

      const terminal = await fork.terminalState(req.position);

      return {
        agentId: agent.id,
        agentName: agent.name,
        opened: seeded.openedAt,
        terminal,
        actions,
        deltaVsDoNothingUsd: terminal.valueUsd - doNothing.valueUsd,
        replayHash: hash,
        failed,
        ...(failureReason === undefined ? {} : { failureReason }),
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
