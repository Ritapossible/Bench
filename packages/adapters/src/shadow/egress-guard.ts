import { BenchError, type EgressDecision, type EgressGuard } from '@bench/core';

export interface EgressGuardOptions {
  readonly budgetUsd: number;
  /** Outbound hosts a shadowed agent may reach. Empty = deny all. */
  readonly allowlist: readonly string[];
}

/**
 * Real implementation, not a stub — this one is pure logic and it is the
 * safety-critical piece, so it exists from day one.
 *
 * A shadowed agent still makes REAL outbound calls: x402-paid data feeds,
 * price oracles, LLM inference. The fork sandboxes its *transactions*, not its
 * network access. Without a hard ceiling, running a hundred auditions bills
 * real money to a real card. See ARCHITECTURE.md 3.3.
 *
 * Deny-by-default on both axes: an unlisted host is refused, and so is a call
 * that would take the run past its budget.
 */
/**
 * Runs to remember spending for.
 *
 * The map had no bound, so a long-lived worker accumulated one entry per
 * audition for as long as it stayed up. Small entries, but this is a process
 * meant to run for weeks, and "it only leaks slowly" is how a worker ends up
 * restarting nightly for reasons nobody has looked into.
 */
const MAX_TRACKED_RUNS = 10_000;

export class InMemoryEgressGuard implements EgressGuard {
  readonly #spent = new Map<string, number>();

  constructor(private readonly opts: EgressGuardOptions) {}

  /** Oldest-first: Map preserves insertion order, so the first key is oldest. */
  #evictIfFull(): void {
    while (this.#spent.size >= MAX_TRACKED_RUNS) {
      const oldest = this.#spent.keys().next();
      if (oldest.done === true) return;
      this.#spent.delete(oldest.value);
    }
  }

  async check(runId: string, host: string, estimatedCostUsd: number): Promise<EgressDecision> {
    if (!this.opts.allowlist.includes(host)) {
      return { allowed: false, reason: 'host-not-allowlisted' };
    }
    const spent = this.#spent.get(runId) ?? 0;
    if (spent + estimatedCostUsd > this.opts.budgetUsd) {
      return { allowed: false, reason: 'over-budget' };
    }
    return { allowed: true };
  }

  async record(runId: string, costUsd: number): Promise<void> {
    if (!this.#spent.has(runId)) this.#evictIfFull();
    const spent = (this.#spent.get(runId) ?? 0) + costUsd;
    this.#spent.set(runId, spent);
    if (spent > this.opts.budgetUsd) {
      // Recorded actuals exceeded the estimate that was approved. The run is
      // halted rather than allowed to keep spending: over-budget is a stop
      // condition, not a warning.
      throw new BenchError(
        'EGRESS_BUDGET_EXCEEDED',
        `Run ${runId} spent $${spent.toFixed(4)} against a $${this.opts.budgetUsd} budget`,
      );
    }
  }

  async spent(runId: string): Promise<number> {
    return this.#spent.get(runId) ?? 0;
  }
}
