import type {
  AgentCategory,
  AgentId,
  AuditionEvidence,
  AuditionStore,
  ChainName,
} from '@bench/core';

/**
 * The Agent Advantage Report - a required submission deliverable.
 *
 * The brief asks for at least three real tasks run both ways, with time, cost
 * and output quality reported and the outputs attached, and at least one task
 * from trading, stocks or security. Most submissions will write that by hand
 * from memory.
 *
 * It is generated here instead, because an audition already *is* the comparison
 * the report asks for: the same position, the same window, the same fork block,
 * the agent measured against a do-nothing baseline that ran on identical state.
 * Writing it by hand would mean re-typing numbers that already exist, and a
 * hand-typed number is one nobody can check.
 *
 * Every figure below is derived from a recorded run. Nothing is estimated, and
 * where evidence is missing the report says so rather than filling the gap -
 * a report that cannot be checked is worth less than no report.
 */

export interface AdvantageTask {
  readonly agent: AgentId;
  readonly agentName: string;
  readonly category: AgentCategory;
  readonly runId: string;
  /** Lets a reader re-run the window and get the same starting state. */
  readonly replayHash: string;
  readonly windowLabel: string;
  readonly forkBlock: bigint;
  readonly positionLabel: string;

  /** The run: what the agent did, and what it cost to let it. */
  readonly withAgent: {
    readonly terminalUsd: number;
    readonly actionCount: number;
    readonly maxDrawdownUsd: number;
    /** Wall clock, null when a run predates timing being recorded. */
    readonly durationMs: number | null;
    /** Real money: the agent's outbound x402 data calls during the run. */
    readonly costUsd: number;
    /** Gas, split out: it is measured, where egress is metered only in-process. */
    readonly gasUsd: number;
    readonly egressUsd: number;
    /** The outputs, attached. Every transaction it tried to make. */
    readonly actions: readonly {
      readonly seq: number;
      readonly to: string | null;
      readonly valueWei: string;
      readonly selector: string;
      readonly succeeded: boolean;
    }[];
  };

  /**
   * The control. Not a second measurement but the same one: the baseline is
   * the position left alone over the identical window, which is what
   * `deltaVsDoNothingUsd` is measured against.
   */
  readonly withoutAgent: {
    readonly terminalUsd: number;
    readonly actionCount: 0;
    readonly costUsd: 0;
  };

  readonly deltaUsd: number;
  /** Positive delta with fewer dollars spent than gained. */
  readonly agentWon: boolean;
}

export interface AdvantageReport {
  readonly chain: ChainName;
  readonly generatedAt: Date;
  readonly tasks: readonly AdvantageTask[];
  /** The brief asks for at least three. Stated rather than assumed. */
  readonly meetsTaskMinimum: boolean;
  /** At least one task must come from trading, stocks or security. */
  readonly meetsCategoryRequirement: boolean;
  readonly totals: {
    readonly tasks: number;
    readonly agentWins: number;
    readonly netDeltaUsd: number;
    readonly totalCostUsd: number;
  };
}

/** The brief's "trading, stock or security" bucket, in this catalog's terms. */
const HIGH_STAKES: readonly AgentCategory[] = ['grid', 'rebalancing', 'health-factor'];

const selectorOf = (data: string): string =>
  data.length >= 10 ? data.slice(0, 10).toLowerCase() : '0x';

function toTask(e: AuditionEvidence): AdvantageTask {
  const terminalUsd = e.outcome.terminal.valueUsd;
  const delta = e.outcome.deltaVsDoNothingUsd;
  /**
   * What running the agent actually cost.
   *
   * Gas plus metered egress, not egress alone. Egress is zero for every remote
   * agent - the A2A and MCP shims call the endpoint directly rather than
   * through the meter - so `agentWon: delta > costUsd` was `0 > 0` and the
   * required cost comparison was being made against nothing. Gas is measured
   * from the receipts of the transactions this system executed, so it is the
   * one cost an audition can state without qualification.
   */
  const costUsd = e.run.gasSpentUsd + e.run.egressSpentUsd;
  const started = e.run.startedAt?.getTime();
  const finished = e.run.finishedAt?.getTime();

  return {
    agent: e.run.agent,
    agentName: e.agentName ?? `agent ${e.run.agent.tokenId.toString()}`,
    category: e.category,
    runId: e.run.id,
    replayHash: e.replayHash,
    windowLabel: e.run.window.label,
    forkBlock: e.run.window.forkBlock,
    positionLabel: e.run.position.label,
    withAgent: {
      terminalUsd,
      actionCount: e.outcome.actionCount,
      maxDrawdownUsd: e.outcome.maxDrawdownUsd,
      durationMs: started === undefined || finished === undefined ? null : finished - started,
      gasUsd: e.run.gasSpentUsd,
      egressUsd: e.run.egressSpentUsd,
      costUsd,
      actions: e.actions.map((a) => ({
        seq: a.seq,
        to: a.to,
        valueWei: a.value.toString(),
        selector: selectorOf(a.data),
        succeeded: a.simulated.success,
      })),
    },
    // The baseline is derived, not separately measured: the delta is defined as
    // agent-minus-do-nothing over the same window, so the control is exactly
    // one subtraction away and cannot drift from it.
    withoutAgent: { terminalUsd: terminalUsd - delta, actionCount: 0, costUsd: 0 },
    deltaUsd: delta,
    // Winning means beating the baseline by more than it cost to run - an
    // agent that gains $3 while spending $5 on data has not helped anyone.
    agentWon: delta > costUsd,
  };
}

export async function buildAdvantageReport(
  store: AuditionStore,
  chain: ChainName,
  limit = 10,
): Promise<AdvantageReport> {
  const tasks = (await store.completedAuditions(chain, limit)).map(toTask);

  return {
    chain,
    generatedAt: new Date(),
    tasks,
    meetsTaskMinimum: tasks.length >= 3,
    meetsCategoryRequirement: tasks.some((t) => HIGH_STAKES.includes(t.category)),
    totals: {
      tasks: tasks.length,
      agentWins: tasks.filter((t) => t.agentWon).length,
      netDeltaUsd: tasks.reduce((a, t) => a + t.deltaUsd, 0),
      totalCostUsd: tasks.reduce((a, t) => a + t.withAgent.costUsd, 0),
    },
  };
}
