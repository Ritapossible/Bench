import { describe, expect, it } from 'vitest';
import type {
  AgentRecord,
  AuditionStore,
  AuditionWindow,
  CatalogPage,
  CatalogRepository,
  ForkHandle,
  ForkProvider,
  Hex,
  InterceptedAction,
  OutcomeRecord,
  PositionTemplate,
  ShadowRun,
} from '@bench/core';
import { AuditionRunner } from '../src/audition.js';
import { AuditionService } from '../src/audition-service.js';

const USDT = '0x55d398326f99059ff775485246999027b3197955' as const;
const FRESH = new Date();

const liveness = (probedAt: Date | null) => ({
  agent: { chain: 'bsc-testnet' as const, tokenId: 1n },
  lastProbedAt: probedAt,
  reachable: probedAt !== null,
  conformant: probedAt !== null,
  uptimeBps: 9_900,
  p95LatencyMs: 100,
  probeCount: 50,
});

const agent = (tokenId: bigint, withA2a = true): AgentRecord => ({
  id: { chain: 'bsc-testnet', tokenId },
  owner: `0x${'11'.repeat(20)}`,
  cardUri: 'data:x',
  card: {
    name: `Agent ${tokenId}`,
    description: '',
    category: 'yield',
    endpoints: withA2a ? [{ protocol: 'a2a', url: `https://a.example/${tokenId}` }] : [],
    permissions: { contractAllowlist: [], requiresTokenApprovals: true },
    raw: {},
  },
  registeredAt: new Date(0),
});

class StubCatalog implements Partial<CatalogRepository> {
  constructor(private readonly records: readonly AgentRecord[]) {}
  async query(): Promise<CatalogPage> {
    return {
      entries: this.records.map((record) => ({
        record,
        liveness: { ...liveness(FRESH), agent: record.id },
        verifiedLive: true,
      })),
      nextCursor: null,
    };
  }
}

class StubStore implements Partial<AuditionStore> {
  readonly runs: ShadowRun[] = [];
  readonly outcomes: OutcomeRecord[] = [];
  readonly actions: InterceptedAction[][] = [];
  constructor(private readonly existing: readonly ShadowRun[] = []) {}
  async runsFor(_agent?: unknown): Promise<readonly ShadowRun[]> {
    return this.existing;
  }
  async putRun(run: ShadowRun, actions: readonly InterceptedAction[]): Promise<void> {
    this.runs.push(run);
    this.actions.push([...actions]);
  }
  async putOutcome(o: OutcomeRecord): Promise<void> {
    this.outcomes.push(o);
  }
}

/** Terminal value per spawn; the first spawn is the do-nothing baseline. */
class FakeForks implements ForkProvider {
  spawned = 0;
  constructor(private readonly values: readonly number[]) {}
  async spawn(): Promise<ForkHandle> {
    const n = this.spawned;
    this.spawned += 1;
    const values = this.values;
    return {
      id: `f${n}`,
      rpcUrl: `http://127.0.0.1:${9000 + n}`,
      async seedPosition() {
        return {
          controller: `0x${'22'.repeat(20)}` as const,
          openedAt: { valueUsd: 10_000, detail: {} },
        };
      },
      onAction() {},
      async gasPriceWei(): Promise<bigint> {
        return 0n;
      },
      async terminalState() {
        return { valueUsd: values[n] ?? 10_000, detail: {} };
      },
      async destroy() {},
    };
  }
  replayHash(): Hex {
    return `0x${'ab'.repeat(32)}`;
  }
}

const window_: AuditionWindow = {
  id: 'w1',
  label: 'test',
  regime: 'live',
  forkBlock: 1n,
  endBlock: 2n,
  seed: 's',
};

const position: PositionTemplate = {
  kind: 'spot-balance',
  label: 'p',
  params: {},
  capital: { token: USDT, symbol: 'USDT', decimals: 18, amount: 10_000n * 10n ** 18n },
};

const build = (records: readonly AgentRecord[], store: StubStore, forks: FakeForks, over = {}) =>
  new AuditionService(
    {
      forks,
      catalog: new StubCatalog(records) as unknown as CatalogRepository,
      store: store as unknown as AuditionStore,
      runner: new AuditionRunner({ forks }),
      agentFor: ({ agent: a }) =>
        a.card?.endpoints.some((e) => e.protocol === 'a2a') === true
          ? { id: `${a.id.chain}:${a.id.tokenId}`, name: 'x', run: async () => {} }
          : null,
    },
    { chain: 'bsc-testnet', archiveRpcUrl: 'http://unused', ...over },
  );

describe('AuditionService', () => {
  it('persists a run and an outcome for every agent it auditions', async () => {
    // The gap this service exists to close: AuditionRunner produced a report
    // and nothing wrote it down, so no agent could ever be scored or hired.
    const store = new StubStore();
    const svc = build([agent(1n), agent(2n)], store, new FakeForks([10_000, 10_400, 9_700]));

    const r = await svc.tick(window_, position);

    expect(r.auditioned).toBe(2);
    expect(store.runs).toHaveLength(2);
    expect(store.outcomes).toHaveLength(2);
    // Deltas are measured from the do-nothing baseline, not from the opening.
    expect(store.outcomes.map((o) => o.deltaVsDoNothingUsd).sort((a, b) => a - b)).toEqual([
      -300, 400,
    ]);
  });

  it('writes the run before the outcome that references it', async () => {
    // outcome_records has a foreign key onto shadow_runs; the other order fails
    // against a real database and would only show up in integration.
    const store = new StubStore();
    await build([agent(1n)], store, new FakeForks([10_000, 10_100])).tick(window_, position);
    expect(store.runs).toHaveLength(1);
    expect(store.outcomes[0]?.runId).toBe(store.runs[0]?.id);
  });

  it('skips agents with no A2A endpoint rather than failing them', async () => {
    // Never auditionable is a different fact from tried and failed, and only
    // one of them should count against an agent.
    const store = new StubStore();
    const r = await build([agent(1n, false)], store, new FakeForks([10_000])).tick(
      window_,
      position,
    );

    expect(r.auditioned).toBe(0);
    expect(r.skipped).toBe(1);
    expect(store.runs).toHaveLength(0);
  });

  it('does not re-audition an agent inside the re-audition window', async () => {
    const recent: ShadowRun = {
      id: 'old',
      agent: { chain: 'bsc-testnet', tokenId: 1n },
      window: window_,
      position,
      status: 'complete',
      startedAt: new Date(),
      finishedAt: new Date(),
      egressSpentUsd: 0,
      gasSpentUsd: 0,
    };
    const store = new StubStore([recent]);
    const r = await build([agent(1n)], store, new FakeForks([10_000])).tick(window_, position);

    expect(r.auditioned).toBe(0);
    expect(r.skipped).toBe(1);
  });

  it('records a failed audition rather than discarding it', async () => {
    // "This agent could not be made to do anything" is the finding a catalog of
    // mostly-dead agents exists to publish.
    const store = new StubStore();
    const forks = new FakeForks([10_000, 9_900]);
    const svc = new AuditionService(
      {
        forks,
        catalog: new StubCatalog([agent(1n)]) as unknown as CatalogRepository,
        store: store as unknown as AuditionStore,
        runner: new AuditionRunner({ forks }),
        agentFor: () => ({
          id: 'bsc-testnet:1',
          name: 'x',
          run: async () => {
            throw new Error('agent returned HTTP 404 to the audition task');
          },
        }),
      },
      { chain: 'bsc-testnet', archiveRpcUrl: 'http://unused' },
    );

    const r = await svc.tick(window_, position);

    expect(r.failed).toBe(1);
    expect(store.runs[0]?.status).toBe('failed');
    expect(store.runs[0]?.failureReason).toContain('404');
    // Still measured: what it did before failing is real behaviour.
    expect(store.outcomes).toHaveLength(1);
  });

  it('bounds a tick to its batch size', async () => {
    const store = new StubStore();
    const r = await build(
      [agent(1n), agent(2n), agent(3n), agent(4n)],
      store,
      new FakeForks([10_000, 10_000, 10_000]),
      { batchSize: 2 },
    ).tick(window_, position);

    expect(r.auditioned).toBe(2);
  });
});

describe('AuditionService skip reasons', () => {
  /**
   * A tick reporting "considered 20, auditioned 0, skipped 20" and nothing else
   * took four separate investigations to explain. `skipped` alone cannot
   * distinguish an exhausted catalog from an undrivable one from a broken one,
   * and those need three different responses.
   */
  it('names why each agent was skipped', async () => {
    // Two with no drivable endpoint, one audited within the re-audition floor.
    const recent: ShadowRun = {
      id: 'r-recent',
      agent: { chain: 'bsc-testnet', tokenId: 3n },
      window: window_,
      position,
      status: 'complete',
      startedAt: new Date(),
      finishedAt: new Date(),
      egressSpentUsd: 0,
      gasSpentUsd: 0,
    };
    // Agent-aware: the shared stub returns the same run for every agent, which
    // would make all three read as recently audited and hide the reason under
    // test.
    class PerAgentStore extends StubStore {
      override async runsFor(a: { readonly tokenId: bigint }): Promise<readonly ShadowRun[]> {
        return a.tokenId === 3n ? [recent] : [];
      }
    }
    const svc = build(
      [agent(1n, false), agent(2n, false), agent(3n, true)],
      new PerAgentStore(),
      new FakeForks([10_000]),
    );

    const r = await svc.tick(window_, position);

    expect(r.skipped).toBe(3);
    expect(r.skipReasons['no drivable endpoint']).toBe(2);
    expect(r.skipReasons['audited recently']).toBe(1);
    expect(r.auditioned).toBe(0);
  });

  it('reports nothing to explain when nothing was skipped', async () => {
    const svc = build([], new StubStore(), new FakeForks([]));
    const r = await svc.tick(window_, position);
    expect(r.skipped).toBe(0);
    expect(r.skipReasons).toEqual({});
  });
});

describe('per-call batch size', () => {
  it('lets one caller cover more agents than the shared cadence does', async () => {
    // The shared window is paced at six agents a tick. An on-demand report is
    // a person waiting on an answer about their own position, and auditioning
    // six of twenty while the page says "every verified-live agent" would make
    // that sentence false.
    const agents = Array.from({ length: 12 }, (_, i) => agent(BigInt(i + 1)));
    const store = new StubStore([]);
    const r = await build(agents, store, new FakeForks(Array(13).fill(10_000))).tick(
      window_,
      position,
      { batchSize: 12 },
    );

    expect(r.auditioned).toBe(12);
  });

  it('still honours the default when no caller asks for more', async () => {
    const agents = Array.from({ length: 12 }, (_, i) => agent(BigInt(i + 1)));
    const store = new StubStore([]);
    const r = await build(agents, store, new FakeForks(Array(13).fill(10_000))).tick(
      window_,
      position,
    );

    expect(r.auditioned).toBe(6);
  });
});
