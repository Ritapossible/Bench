import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  agentKey,
  type Address,
  type AgentId,
  type AgentRecord,
  type InterceptedAction,
  type OutcomeRecord,
  type Score,
  type ShadowRun,
  type TokenAmount,
} from '@bench/core';
import { createDb, PgAuditionStore, PgCatalogRepository, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

const USDT = '0x55d398326f99059ff775485246999027b3197955' as Address;
const VENUS = '0xfd5840cd36d94d7229439859c0112a4185bc0255' as Address;
const OWNER = '0x1111111111111111111111111111111111111111' as Address;

const agent = (tokenId: bigint): AgentId => ({ chain: 'bsc-testnet', tokenId });

const capital: TokenAmount = {
  token: USDT,
  symbol: 'USDT',
  decimals: 18,
  amount: 5_000_000_000_000_000_000_000n,
};

const agentRecord = (tokenId: bigint): AgentRecord => ({
  id: agent(tokenId),
  owner: OWNER,
  cardUri: `ipfs://card/${tokenId}`,
  card: null,
  registeredAt: new Date('2026-08-01T00:00:00.000Z'),
});

const action = (seq: number, value: bigint): InterceptedAction => ({
  seq,
  at: new Date(`2026-08-0${seq + 1}T00:00:00.000Z`),
  to: VENUS,
  value,
  data: '0x1234',
  decoded: null,
  simulated: { success: true, gasUsed: 21_000n },
});

const run = (id: string, a: AgentId, over: Partial<ShadowRun> = {}): ShadowRun => ({
  id,
  agent: a,
  window: {
    id: 'win-crash-1',
    label: 'March crash',
    regime: 'crash',
    forkBlock: 48_000_000n,
    endBlock: 48_100_000n,
    seed: 'seed-1',
  },
  position: {
    kind: 'pcs-lp',
    label: 'PCS BNB/USDT 0.05%',
    params: {
      pool: '0xabc',
      lowerTick: -100,
      upperTick: 100,
      liquidity: 12_345_678_901_234_567_890n,
    },
    capital,
  },
  status: 'complete',
  startedAt: new Date('2026-08-10T00:00:00.000Z'),
  finishedAt: new Date('2026-08-10T01:00:00.000Z'),
  egressSpentUsd: 0.42,
  ...over,
});

const outcome = (runId: string): OutcomeRecord => ({
  runId,
  terminal: { valueUsd: 10_000, detail: {} },
  deltaVsDoNothingUsd: 12.5,
  deltaVsPeerMedianUsd: null,
  maxDrawdownUsd: 4,
  actionCount: 2,
});

const score = (a: AgentId, over: Partial<Score> = {}): Score => ({
  agent: a,
  category: 'rebalancing',
  basis: 'simulated',
  window: {
    start: new Date('2026-08-01T00:00:00.000Z'),
    end: new Date('2026-08-08T00:00:00.000Z'),
  },
  sampleSize: 6,
  baseline: { kind: 'do-nothing' },
  normalized: 0.72,
  meanDeltaUsd: 132.5,
  capitalUsd: 5_000,
  metric: { kind: 'rebalancing', inRangeBps: 8_400, rebalanceCount: 11, feesEarnedUsd: 132.5 },
  ...over,
});

describeDb('PgAuditionStore', () => {
  const db = createDb(URL ?? '');
  const store = new PgAuditionStore(db);
  const catalog = new PgCatalogRepository(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });

  beforeEach(async () => {
    await db.delete(schema.catalogStatsHistory);
    await db.delete(schema.scores);
    await db.delete(schema.outcomeRecords);
    await db.delete(schema.shadowActions);
    await db.delete(schema.shadowRuns);
    await db.delete(schema.agents);
    await catalog.upsertAgents([agentRecord(1n), agentRecord(2n), agentRecord(3n)]);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('round-trips a run, including the bigint inside position params', async () => {
    const r = run('run-1', agent(1n));
    await store.putRun(r, [action(0, 100n), action(1, 200n)]);

    const [read] = await store.runsFor(agent(1n));
    expect(read).toEqual(r);
    expect(read?.position.params['liquidity']).toBe(12_345_678_901_234_567_890n);
    expect(read?.position.capital.amount).toBe(capital.amount);
  });

  it('replaces actions rather than appending, so re-recording cannot double the count', async () => {
    const r = run('run-1', agent(1n));
    await store.putRun(r, [action(0, 100n), action(1, 200n)]);
    await store.putRun(r, [action(0, 100n)]);

    const rows = await db.select().from(schema.shadowActions);
    expect(rows).toHaveLength(1);
  });

  it('refuses to record evidence for an agent that is not indexed', async () => {
    await expect(store.putRun(run('run-x', agent(999n)), [])).rejects.toThrow(/not indexed/);
  });

  it('round-trips an outcome', async () => {
    await store.putRun(run('run-1', agent(1n)), []);
    const o: OutcomeRecord = {
      runId: 'run-1',
      terminal: { valueUsd: 5_142.11, detail: { bnb: 3.2, usdt: 1_900 } },
      deltaVsDoNothingUsd: 142.11,
      deltaVsPeerMedianUsd: null,
      maxDrawdownUsd: 88.4,
      actionCount: 11,
    };
    await store.putOutcome(o, '0xreplay');
    expect((await store.outcomesFor(agent(1n)))[0]).toEqual(o);
  });

  it('leaves outcomes from failed runs out of the default read', async () => {
    // An agent that 404s the task, times out, or refuses it still lands an
    // outcome row: it moved nothing, so its delta against doing nothing is
    // zero. Scoring that beside real results reads "could not be driven at
    // all" as "+$0.00, chose not to act" - opposite findings, and the kinder
    // one wins. The read the scorer uses has to drop it.
    await store.putRun(run('run-ok', agent(1n)), []);
    await store.putOutcome({ ...outcome('run-ok'), deltaVsDoNothingUsd: 142.11 }, '0xreplay-ok');
    await store.putRun(
      run('run-dead', agent(1n), {
        status: 'failed',
        finishedAt: new Date('2026-08-11T01:00:00.000Z'),
        failureReason: 'endpoint returned 404',
      }),
      [],
    );
    await store.putOutcome(
      { ...outcome('run-dead'), deltaVsDoNothingUsd: 0, actionCount: 0 },
      '0xreplay-dead',
    );

    const scored = await store.outcomesFor(agent(1n));
    expect(scored.map((o) => o.runId)).toEqual(['run-ok']);
  });

  it('includes failed runs when the caller asks, for the per-agent history', async () => {
    // The detail page shows every run beside its status and reason, so hiding
    // the failures there would hide the very thing it exists to report.
    await store.putRun(run('run-ok', agent(1n)), []);
    await store.putOutcome(outcome('run-ok'), '0xreplay-ok');
    await store.putRun(
      run('run-dead', agent(1n), {
        status: 'failed',
        finishedAt: new Date('2026-08-11T01:00:00.000Z'),
        failureReason: 'endpoint returned 404',
      }),
      [],
    );
    await store.putOutcome(outcome('run-dead'), '0xreplay-dead');

    const all = await store.outcomesFor(agent(1n), 20, { includeFailed: true });
    expect(all.map((o) => o.runId)).toEqual(['run-dead', 'run-ok']);
  });

  it('reports no outcomes at all for an agent whose every audition failed', async () => {
    // This is the state twenty catalog cards were actually in. It has to come
    // back empty rather than as a zero, so the caller can say "could not be
    // driven" instead of showing a score built on nothing.
    await store.putRun(run('run-dead', agent(2n), { status: 'failed' }), []);
    await store.putOutcome(outcome('run-dead'), '0xreplay-dead');

    expect(await store.outcomesFor(agent(2n))).toEqual([]);
  });

  it('round-trips the dollars a score was built from', async () => {
    // These are the only place the measured amounts survive: `normalized` is a
    // bounded tanh and cannot be inverted. If the columns drop them, every
    // page showing money is back to reconstructing a figure that never
    // existed.
    await store.putScore(score(agent(1n), { meanDeltaUsd: -412.5, capitalUsd: 25_000 }));

    const read = await store.latestScore(agent(1n), 'simulated');
    expect(read?.meanDeltaUsd).toBe(-412.5);
    expect(read?.capitalUsd).toBe(25_000);
  });

  it('returns the newest score per agent in one query', async () => {
    await store.putScore(score(agent(1n)));
    await store.putScore(
      score(agent(1n), {
        window: {
          start: new Date('2026-08-08T00:00:00.000Z'),
          end: new Date('2026-08-15T00:00:00.000Z'),
        },
        normalized: 0.81,
      }),
    );
    await store.putScore(score(agent(2n), { normalized: 0.33 }));

    const map = await store.latestScores([agent(1n), agent(2n), agent(3n)], 'simulated');

    expect(map.get(agentKey(agent(1n)))?.normalized).toBe(0.81);
    expect(map.get(agentKey(agent(2n)))?.normalized).toBe(0.33);
    // Agent 3 has no score. Absent, not zero - the caller has to be able to
    // render "not audited yet" rather than a zero that looks like a verdict.
    expect(map.has(agentKey(agent(3n)))).toBe(false);
  });

  it('never returns a realized score when asked for simulated', async () => {
    await store.putScore(score(agent(1n), { basis: 'simulated', normalized: 0.7 }));
    await store.putScore(score(agent(1n), { basis: 'realized', normalized: 0.2 }));

    expect((await store.latestScore(agent(1n), 'simulated'))?.normalized).toBe(0.7);
    expect((await store.latestScore(agent(1n), 'realized'))?.normalized).toBe(0.2);
  });

  it('does not cross agent identities when chains and token ids are mixed', async () => {
    // The pair filter has to match (chain, tokenId) together. Narrowing by each
    // column separately would return agent 2 for a query naming only agent 1.
    await store.putScore(score(agent(1n), { normalized: 0.11 }));
    await store.putScore(score(agent(2n), { normalized: 0.22 }));

    const map = await store.latestScores([agent(1n)], 'simulated');
    expect([...map.keys()]).toEqual([agentKey(agent(1n))]);
  });

  it('ranks a category by normalized score', async () => {
    await store.putScore(score(agent(1n), { normalized: 0.4 }));
    await store.putScore(score(agent(2n), { normalized: 0.9 }));
    await store.putScore(score(agent(3n), { category: 'yield', normalized: 0.99 }));

    const top = await store.topByCategory('rebalancing', 'simulated', 10);
    expect(top.map((s) => s.normalized)).toEqual([0.9, 0.4]);
  });

  it('records at most one density measurement per hour', async () => {
    // The indexer ticks every thirty seconds. Without this, ninety stored
    // points would cover forty-five minutes, and the registry health page
    // asks a question measured in days.
    const base = Date.parse('2026-08-20T00:00:00.000Z');
    for (const minutes of [0, 10, 45, 61, 70, 130]) {
      await store.recordStats({
        chain: 'bsc-testnet',
        registered: 100,
        withResolvableCard: 40,
        verifiedLive: minutes,
        computedAt: new Date(base + minutes * 60_000),
      });
    }
    const history = await store.statsHistory('bsc-testnet');
    expect(history.map((h) => h.verifiedLive)).toEqual([0, 61, 130]);
  });

  it('keeps catalog density as a history rather than one repeated number', async () => {
    for (const [i, live] of [3, 5, 8].entries()) {
      await store.recordStats({
        chain: 'bsc-testnet',
        registered: 100,
        withResolvableCard: 40,
        verifiedLive: live,
        computedAt: new Date(`2026-08-${10 + i}T00:00:00.000Z`),
      });
    }
    const history = await store.statsHistory('bsc-testnet');
    // Oldest first, so a caller can plot it without reversing.
    expect(history.map((h) => h.verifiedLive)).toEqual([3, 5, 8]);
  });

  it('reads back what putRun wrote, so the envelope has a real input', async () => {
    // putRun had no counterpart, so every recorded action was written and never
    // read. The hire path invented actions instead - identical values for every
    // agent - and the envelope derived from them described no agent at all.
    await store.putRun(run('r1', agent(1n)), [
      action(0, 5n * 10n ** 17n),
      action(1, 3n * 10n ** 17n),
    ]);

    const got = await store.actionsForRuns(['r1']);

    expect(got.get('r1')).toHaveLength(2);
    expect(got.get('r1')?.[0]?.value).toBe(5n * 10n ** 17n);
    expect(got.get('r1')?.[0]?.to).toBe(VENUS);
    expect(got.get('r1')?.[0]?.simulated.gasUsed).toBe(21_000n);
  });

  it('returns actions in the order the agent took them', async () => {
    // The envelope folds a run cumulatively; a shuffled run yields a bound the
    // agent never established.
    await store.putRun(run('r1', agent(1n)), [action(2, 3n), action(0, 1n), action(1, 2n)]);

    expect((await store.actionsForRuns(['r1']))?.get('r1')?.map((a) => a.seq)).toEqual([0, 1, 2]);
  });

  it('groups by run and asks for all of them at once', async () => {
    await store.putRun(run('r1', agent(1n)), [action(0, 1n)]);
    await store.putRun(run('r2', agent(2n)), [action(0, 2n), action(1, 3n)]);

    const got = await store.actionsForRuns(['r1', 'r2']);

    expect(got.get('r1')).toHaveLength(1);
    expect(got.get('r2')).toHaveLength(2);
  });

  it('is a no-op on an empty request rather than a query for everything', async () => {
    expect((await store.actionsForRuns([])).size).toBe(0);
  });

  it('omits a run with no recorded actions instead of inventing any', async () => {
    await store.putRun(run('r1', agent(1n)), []);
    expect((await store.actionsForRuns(['r1'])).get('r1')).toBeUndefined();
  });

  it('finds an audited agent regardless of where its token id sits', async () => {
    // The scorer took the first page of the catalog ordered by token id, so it
    // could only ever see the low ids. The one agent that audited successfully
    // in production was #1581 of 2,066 and was never looked at, so a working
    // audition still produced no score.
    await store.putRun(run('r-high', agent(3n)), [action(0, 1n)]);
    await store.putOutcome(outcome('r-high'), '0xhash');

    const found = await store.agentsWithOutcomes('bsc-testnet');

    expect(found.map((f) => f.agent.tokenId)).toContain(3n);
  });

  it('returns an agent once however many times it was audited', async () => {
    await store.putRun(run('r-a', agent(1n)), []);
    await store.putOutcome(outcome('r-a'), '0xhash');
    await store.putRun(run('r-b', agent(1n)), []);
    await store.putOutcome(outcome('r-b'), '0xhash');

    const found = await store.agentsWithOutcomes('bsc-testnet');

    expect(found.filter((f) => f.agent.tokenId === 1n)).toHaveLength(1);
  });

  it('leaves out an agent with a run but no outcome', async () => {
    // A run that failed before producing an outcome is not evidence to score.
    await store.putRun(run('r-none', agent(2n)), []);

    const found = await store.agentsWithOutcomes('bsc-testnet');

    expect(found.map((f) => f.agent.tokenId)).not.toContain(2n);
  });

  it('carries the category the scorer needs to pick a metric', async () => {
    await store.putRun(run('r-cat', agent(1n)), []);
    await store.putOutcome(outcome('r-cat'), '0xhash');

    const found = await store.agentsWithOutcomes('bsc-testnet');

    expect(found.find((f) => f.agent.tokenId === 1n)?.category).toBeDefined();
  });
});
