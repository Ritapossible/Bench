import type {
  AgentEndpoint,
  AgentId,
  CatalogRepository,
  ProbeClient,
  ProbeResult,
  ProbeTarget,
} from '@bench/core';
import { describe, expect, it } from 'vitest';
import { Prober } from '../src/prober.js';

const endpoint: AgentEndpoint = { protocol: 'a2a', url: 'https://a.example/a2a' };
const agentN = (n: bigint): AgentId => ({ chain: 'bsc-testnet', tokenId: n });

class StubRepo implements Partial<CatalogRepository> {
  readonly recorded: ProbeResult[] = [];
  targets: ProbeTarget[] = [];

  async dueForProbe(limit: number): Promise<readonly ProbeTarget[]> {
    return this.targets.slice(0, limit);
  }
  async recordProbe(r: ProbeResult): Promise<void> {
    this.recorded.push(r);
  }
}

const ok = (agent: AgentId, conformant: boolean): ProbeResult => ({
  agent,
  endpoint,
  at: new Date(),
  reachable: true,
  latencyMs: 50,
  conformant,
});

const build = (probes: ProbeClient, repo: StubRepo) =>
  new Prober(probes, repo as unknown as CatalogRepository);

describe('Prober', () => {
  it('counts conformance separately from reachability', async () => {
    // Two endpoints answer; only one speaks its declared protocol. Collapsing
    // these would make "verified live" mean "returns 200", which is the exact
    // failure Bench exists to fix.
    const repo = new StubRepo();
    repo.targets = [
      { agent: agentN(1n), endpoint, lastProbedAt: null },
      { agent: agentN(2n), endpoint, lastProbedAt: null },
    ];
    const client: ProbeClient = { probe: async (a) => ok(a, a.tokenId === 1n) };

    const r = await build(client, repo).tick();

    expect(r.probed).toBe(2);
    expect(r.reachable).toBe(2);
    expect(r.conformant).toBe(1);
    expect(repo.recorded).toHaveLength(2);
  });

  it('persists every probe, including the failures', async () => {
    const repo = new StubRepo();
    repo.targets = [{ agent: agentN(1n), endpoint, lastProbedAt: null }];
    const client: ProbeClient = {
      probe: async (agent, ep) => ({
        agent,
        endpoint: ep,
        at: new Date(),
        reachable: false,
        latencyMs: null,
        conformant: false,
        error: 'connection refused',
      }),
    };

    const r = await build(client, repo).tick();

    // Proving an agent is dead is exactly as valuable as proving one is alive.
    expect(repo.recorded).toHaveLength(1);
    expect(r.reachable).toBe(0);
  });

  it('does not lose the batch when the probe client itself breaks', async () => {
    const repo = new StubRepo();
    repo.targets = [
      { agent: agentN(1n), endpoint, lastProbedAt: null },
      { agent: agentN(2n), endpoint, lastProbedAt: null },
    ];
    const client: ProbeClient = {
      probe: async (a) => {
        if (a.tokenId === 2n) throw new Error('probe client exploded');
        return ok(a, true);
      },
    };

    const r = await build(client, repo).tick();

    expect(r.failed).toBe(1);
    expect(r.probed).toBe(1);
    expect(repo.recorded).toHaveLength(1);
  });

  it('is a clean no-op with nothing due', async () => {
    const client: ProbeClient = {
      probe: async () => {
        throw new Error('should not be called');
      },
    };
    const r = await build(client, new StubRepo()).tick();
    expect(r).toEqual({ probed: 0, reachable: 0, conformant: 0, failed: 0 });
  });

  it('respects the batch size so one tick cannot run away', async () => {
    const repo = new StubRepo();
    repo.targets = Array.from({ length: 50 }, (_, i) => ({
      agent: agentN(BigInt(i)),
      endpoint,
      lastProbedAt: null,
    }));
    const client: ProbeClient = { probe: async (a) => ok(a, true) };

    const prober = new Prober(client, repo as unknown as CatalogRepository, { batchSize: 10 });
    const r = await prober.tick();

    expect(r.probed).toBe(10);
  });
});
