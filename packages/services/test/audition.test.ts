import { describe, expect, it } from 'vitest';
import {
  BenchError,
  type Address,
  type AuditionWindow,
  type EgressDecision,
  type EgressGuard,
  type ForkHandle,
  type ForkProvider,
  type Hex,
  type PositionTemplate,
  type SeededPosition,
  type SpawnForkOptions,
  type TerminalState,
  type TokenAmount,
} from '@bench/core';
import { AuditionRunner, type ShadowAgent, type ShadowAgentContext } from '../src/audition.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const CONTROLLER = '0x2222222222222222222222222222222222222222' as Address;

const window_: AuditionWindow = {
  id: 'win-crash-1',
  label: 'March crash',
  regime: 'crash',
  forkBlock: 48_000_000n,
  endBlock: 48_100_000n,
  seed: 'seed-1',
};

const capital: TokenAmount = {
  token: USDT,
  symbol: 'USDT',
  decimals: 18,
  amount: 10_000n * 10n ** 18n,
};

const position: PositionTemplate = {
  kind: 'pcs-lp',
  label: 'PCS v3 BNB/USDT 0.05%',
  params: {},
  capital,
};

/**
 * A fake fork whose terminal value is decided per agent.
 *
 * The runner's job is orchestration - same window, same position, one fork
 * each, a baseline nobody acts on - so the fork's own behaviour is scripted
 * rather than simulated. What is being tested is what the runner does with it.
 */
class FakeForks implements ForkProvider {
  spawned = 0;
  destroyed = 0;
  readonly seenWindows: AuditionWindow[] = [];

  /** Terminal value returned for the Nth spawn. The first spawn is the baseline. */
  constructor(private readonly values: readonly number[]) {}

  async spawn(opts: SpawnForkOptions): Promise<ForkHandle> {
    const n = this.spawned;
    this.spawned += 1;
    this.seenWindows.push(opts.window);

    const values = this.values;
    const destroyed = () => {
      this.destroyed += 1;
    };

    return {
      id: `fork_${n}`,
      rpcUrl: `http://127.0.0.1:${9000 + n}`,
      async seedPosition(): Promise<SeededPosition> {
        return { controller: CONTROLLER, openedAt: { valueUsd: 10_000, detail: {} } };
      },
      // The runner registers a listener; these fakes emit no actions, so it is
      // accepted and dropped rather than stored.
      onAction() {},
      async terminalState(): Promise<TerminalState> {
        return { valueUsd: values[n] ?? 10_000, detail: {} };
      },
      async destroy() {
        destroyed();
      },
    };
  }

  replayHash(): Hex {
    return `0x${'ab'.repeat(32)}` as Hex;
  }
}

/**
 * A budget guard, local to this file.
 *
 * @bench/services depends on @bench/core only - reaching for the concrete
 * InMemoryEgressGuard in @bench/adapters would leak the seam the package is
 * built around, even from a test. It is also the better test: what is being
 * checked here is that the runner uses the port correctly, and the adapter's
 * own arithmetic already has its own tests.
 */
class BudgetGuard implements EgressGuard {
  readonly #spent = new Map<string, number>();
  constructor(
    private readonly budgetUsd: number,
    private readonly allowlist: readonly string[],
  ) {}

  async check(runId: string, host: string, cost: number): Promise<EgressDecision> {
    if (!this.allowlist.includes(host)) return { allowed: false, reason: 'host-not-allowlisted' };
    if ((this.#spent.get(runId) ?? 0) + cost > this.budgetUsd)
      return { allowed: false, reason: 'over-budget' };
    return { allowed: true };
  }

  async record(runId: string, cost: number): Promise<void> {
    this.#spent.set(runId, (this.#spent.get(runId) ?? 0) + cost);
  }

  async spent(runId: string): Promise<number> {
    return this.#spent.get(runId) ?? 0;
  }
}

const agent = (id: string, run?: (ctx: ShadowAgentContext) => Promise<void>): ShadowAgent => ({
  id,
  name: `Agent ${id}`,
  run: run ?? (async () => {}),
});

const request = (agents: readonly ShadowAgent[]) => ({
  window: window_,
  position,
  agents,
  archiveRpcUrl: 'http://archive.invalid',
  agentTimeoutMs: 1_000,
});

describe('AuditionRunner', () => {
  it('runs a do-nothing baseline plus one fork per agent, and destroys every one', async () => {
    const forks = new FakeForks([10_000, 10_300, 9_800]);
    const report = await new AuditionRunner({ forks }).run(request([agent('a'), agent('b')]));

    expect(forks.spawned).toBe(3);
    expect(forks.destroyed).toBe(3);
    expect(report.doNothing.valueUsd).toBe(10_000);
    // The delta each agent is credited with is measured from the baseline, not
    // from its own opening value.
    expect(report.results.map((r) => r.deltaVsDoNothingUsd)).toEqual([300, -200]);
  });

  it('gives every agent the same window, which is what makes the comparison controlled', async () => {
    const forks = new FakeForks([10_000, 10_000, 10_000]);
    await new AuditionRunner({ forks }).run(request([agent('a'), agent('b')]));
    expect(
      forks.seenWindows.every((w) => w.id === window_.id && w.forkBlock === window_.forkBlock),
    ).toBe(true);
  });

  it('records what an agent did before it threw, because that is still behaviour', async () => {
    const forks = new FakeForks([10_000, 9_500]);
    const report = await new AuditionRunner({ forks }).run(
      request([
        agent('boom', async () => {
          throw new Error('strategy exploded');
        }),
      ]),
    );

    const [r] = report.results;
    expect(r?.failed).toBe(true);
    expect(r?.failureReason).toContain('strategy exploded');
    // Still measured, still destroyed - a failure is a finding, not a gap.
    expect(r?.deltaVsDoNothingUsd).toBe(-500);
    expect(forks.destroyed).toBe(2);
  });

  it('stops an agent that hangs instead of hanging the batch', async () => {
    const forks = new FakeForks([10_000, 10_000]);
    const report = await new AuditionRunner({ forks }).run({
      ...request([agent('hang', () => new Promise(() => {}))]),
      agentTimeoutMs: 20,
    });
    expect(report.results[0]?.failed).toBe(true);
    expect(report.results[0]?.failureReason).toContain('timeout');
    expect(forks.destroyed).toBe(2);
  });

  it('takes the peer median across agents that completed, ignoring the ones that did not', async () => {
    const forks = new FakeForks([10_000, 10_100, 10_900, 10_500]);
    const report = await new AuditionRunner({ forks }).run(
      request([
        agent('a'),
        agent('b', async () => {
          throw new Error('x');
        }),
        agent('c'),
      ]),
    );
    // 10_100 and 10_500 completed; 10_900 belonged to the agent that failed.
    expect(report.peerMedianUsd).toBe(10_300);
  });

  it('refuses to audition nothing', async () => {
    const forks = new FakeForks([10_000]);
    await expect(new AuditionRunner({ forks }).run(request([]))).rejects.toThrow(BenchError);
  });

  describe('egress', () => {
    const guard = () => new BudgetGuard(1, ['data.example']);

    it('refuses the network entirely when no guard is configured', async () => {
      // Deny by default. A missing budget must not read as an unlimited one -
      // forgetting to configure the guard is exactly when unlimited billable
      // egress would do the most damage.
      const forks = new FakeForks([10_000, 10_000]);
      let refusal = '';
      await new AuditionRunner({ forks }).run(
        request([
          agent('a', async (ctx) => {
            await ctx.fetch('https://data.example/price').catch((e: Error) => {
              refusal = e.message;
            });
          }),
        ]),
      );
      expect(refusal).toContain('no egress guard is configured');
    });

    it('refuses a host that is not on the allowlist', async () => {
      const forks = new FakeForks([10_000, 10_000]);
      let refusal = '';
      await new AuditionRunner({
        forks,
        egress: guard(),
        httpFetch: async () => new Response('{}'),
      }).run(
        request([
          agent('a', async (ctx) => {
            await ctx.fetch('https://exfiltrate.example/x').catch((e: Error) => {
              refusal = e.message;
            });
          }),
        ]),
      );
      expect(refusal).toContain('host-not-allowlisted');
    });

    it('lets an allowlisted call through and bills it to the run', async () => {
      const forks = new FakeForks([10_000, 10_000]);
      const report = await new AuditionRunner({
        forks,
        egress: guard(),
        httpFetch: async () => new Response('{"price":1}'),
      }).run(
        request([
          agent('a', async (ctx) => {
            const res = await ctx.fetch('https://data.example/price', { estimatedCostUsd: 0.25 });
            expect(await res.text()).toBe('{"price":1}');
            await ctx.fetch('https://data.example/price', { estimatedCostUsd: 0.25 });
          }),
        ]),
      );
      expect(report.results[0]?.egressSpentUsd).toBeCloseTo(0.5);
      expect(report.results[0]?.failed).toBe(false);
    });

    it('stops a run at its budget rather than reporting the overspend afterwards', async () => {
      const forks = new FakeForks([10_000, 10_000]);
      let calls = 0;
      const report = await new AuditionRunner({
        forks,
        egress: guard(),
        httpFetch: async () => {
          calls += 1;
          return new Response('{}');
        },
      }).run(
        request([
          agent('greedy', async (ctx) => {
            for (let i = 0; i < 10; i += 1) {
              await ctx.fetch('https://data.example/price', { estimatedCostUsd: 0.4 });
            }
          }),
        ]),
      );

      // $1 budget, $0.40 a call: two get through, the third is refused before
      // it is made. The agent's own loop does not get to decide when to stop.
      expect(calls).toBe(2);
      expect(report.results[0]?.failed).toBe(true);
      expect(report.results[0]?.egressSpentUsd).toBeCloseTo(0.8);
    });

    it('bills each agent separately, so one cannot spend another out of budget', async () => {
      const forks = new FakeForks([10_000, 10_000, 10_000]);
      const shared = guard();
      const spend = (ctx: ShadowAgentContext) =>
        ctx.fetch('https://data.example/price', { estimatedCostUsd: 0.6 });

      const report = await new AuditionRunner({
        forks,
        egress: shared,
        httpFetch: async () => new Response('{}'),
      }).run(
        request([
          agent('a', async (c) => {
            await spend(c);
          }),
          agent('b', async (c) => {
            await spend(c);
          }),
        ]),
      );

      // Both succeed. Against a shared counter the second would have been
      // refused at $1.20 for something the first agent did.
      expect(report.results.every((r) => !r.failed)).toBe(true);
      expect(report.results.map((r) => r.egressSpentUsd)).toEqual([0.6, 0.6]);
    });
  });
});
