import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  VERIFIED_LIVE,
  type Address,
  type AgentEndpoint,
  type AgentId,
  type AgentCategory,
  type AgentRecord,
  type ProbeResult,
} from '@bench/core';
import { createDb, PgCatalogRepository, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

/**
 * Scheduling, not storage.
 *
 * These run against real Postgres because the rule lives in a HAVING clause
 * over an aggregate, and a stub repository would only re-assert the rule this
 * file exists to check. The bug they pin down shipped: every endpoint got one
 * probe in a deployment's first minutes, nothing was due for an hour, and the
 * site published "0% of the registry is real" for two hours - Bench reporting
 * its own cold start as a finding about the ecosystem.
 */
const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

const OWNER = '0x2222222222222222222222222222222222222222' as Address;
const agent = (tokenId: bigint): AgentId => ({ chain: 'bsc-testnet', tokenId });
const endpointFor = (tokenId: bigint): AgentEndpoint => ({
  protocol: 'a2a',
  url: `https://agent-${tokenId}.example/a2a`,
});

const record = (tokenId: bigint, category: AgentCategory = 'other'): AgentRecord => ({
  id: agent(tokenId),
  owner: OWNER,
  cardUri: `ipfs://card/${tokenId}`,
  card: {
    name: `agent ${tokenId}`,
    description: '',
    category,
    endpoints: [endpointFor(tokenId)],
    permissions: { contractAllowlist: [], requiresTokenApprovals: false },
    raw: {},
  },
  registeredAt: new Date('2026-08-01T00:00:00.000Z'),
});

const probeAt = (tokenId: bigint, at: Date): ProbeResult => ({
  agent: agent(tokenId),
  endpoint: endpointFor(tokenId),
  at,
  reachable: true,
  latencyMs: 40,
  conformant: true,
});

const HOUR = 60 * 60 * 1000;
const BOOTSTRAP = { afterMs: 2 * 60 * 1000, untilProbeCount: VERIFIED_LIVE.minProbeCount };
const ids = (targets: readonly { agent: AgentId }[]): bigint[] =>
  targets.map((t) => t.agent.tokenId).sort((a, b) => Number(a - b));

describeDb('dueForProbe scheduling', () => {
  const db = createDb(URL ?? '');
  const catalog = new PgCatalogRepository(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });

  beforeEach(async () => {
    await db.delete(schema.probeResults);
    await db.delete(schema.agentEndpoints);
    await db.delete(schema.agents);
    await catalog.upsertAgents([record(1n), record(2n), record(3n)]);
  });

  afterAll(async () => {
    await db.$client.end();
  });

  it('offers a never-probed endpoint immediately', async () => {
    expect(ids(await catalog.dueForProbe(10, HOUR, BOOTSTRAP))).toEqual([1n, 2n, 3n]);
  });

  it('re-offers an endpoint short of a verdict without waiting the full hour', async () => {
    // One probe each, five minutes ago: far inside the hourly window, and far
    // short of the three probes a verdict needs.
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    for (const id of [1n, 2n, 3n]) await catalog.recordProbe(probeAt(id, fiveMinAgo));

    expect(ids(await catalog.dueForProbe(10, HOUR, BOOTSTRAP))).toEqual([1n, 2n, 3n]);
    // Without the bootstrap window they would all wait out the hour.
    expect(await catalog.dueForProbe(10, HOUR)).toHaveLength(0);
  });

  it('does not re-offer one probed within the bootstrap window', async () => {
    // Gentleness matters: these are strangers' hosts, not ours.
    const thirtySecAgo = new Date(Date.now() - 30 * 1000);
    for (const id of [1n, 2n, 3n]) await catalog.recordProbe(probeAt(id, thirtySecAgo));

    expect(await catalog.dueForProbe(10, HOUR, BOOTSTRAP)).toHaveLength(0);
  });

  it('stops bootstrapping once the endpoint has enough probes to be judged', async () => {
    // Three probes, the newest five minutes old. Verdict reached, so it drops
    // back to the hourly cadence rather than being probed every two minutes
    // forever.
    for (let i = 0; i < VERIFIED_LIVE.minProbeCount; i++) {
      await catalog.recordProbe(probeAt(1n, new Date(Date.now() - (5 + i * 3) * 60 * 1000)));
    }
    const due = await catalog.dueForProbe(10, HOUR, BOOTSTRAP);
    expect(ids(due)).toEqual([2n, 3n]);
  });

  it('still honours the hourly cadence for a settled endpoint', async () => {
    for (let i = 0; i < VERIFIED_LIVE.minProbeCount; i++) {
      await catalog.recordProbe(probeAt(1n, new Date(Date.now() - (61 + i) * 60 * 1000)));
    }
    expect(ids(await catalog.dueForProbe(10, HOUR, BOOTSTRAP))).toContain(1n);
  });

  it('puts endpoints with no verdict ahead of ones already decided', async () => {
    // A probe that completes a verdict is worth more than the nth probe of one
    // already decided, so a batch smaller than the catalog must spend itself
    // on the undecided.
    for (let i = 0; i < VERIFIED_LIVE.minProbeCount; i++) {
      await catalog.recordProbe(probeAt(1n, new Date(Date.now() - (90 + i) * 60 * 1000)));
    }
    await catalog.recordProbe(probeAt(2n, new Date(Date.now() - 10 * 60 * 1000)));

    const due = await catalog.dueForProbe(2, HOUR, BOOTSTRAP);
    expect(ids(due)).toEqual([2n, 3n]);
  });

  /**
   * Nested inside the block above, not a second `describeDb`.
   *
   * `createDb` caches its pool by connection string, so two top-level blocks
   * share one and the first `afterAll` closes it out from under the second -
   * which fails as "Cannot use a pool after calling end on the pool" and looks
   * like a database problem rather than a test-structure one.
   */
  describe('categoryCounts', () => {
    beforeEach(async () => {
      await db.delete(schema.probeResults);
      await db.delete(schema.agentEndpoints);
      await db.delete(schema.agents);
    });

    it('counts the whole catalog, not a page of it', async () => {
      // The catalog page loaded 200 rows and tallied them in the browser, so the
      // chips described the slice that happened to load. Agent Diversity is one
      // of three main-track criteria, so that number has to be the real one.
      await catalog.upsertAgents([
        record(1n, 'grid'),
        record(2n, 'grid'),
        record(3n, 'rebalancing'),
        record(4n, 'other'),
      ]);

      const counts = await catalog.categoryCounts('bsc-testnet');
      expect(counts.grid).toBe(2);
      expect(counts.rebalancing).toBe(1);
      expect(counts.other).toBe(1);
    });

    it('reports an empty judged category as zero rather than omitting it', async () => {
      // A missing key would let a caller render five chips instead of six and
      // quietly drop the category with no agents - which is exactly the fact
      // this catalog exists to report.
      await catalog.upsertAgents([record(1n, 'grid')]);

      const counts = await catalog.categoryCounts('bsc-testnet');
      expect(counts['health-factor']).toBe(0);
      expect(counts.yield).toBe(0);
      expect(Object.keys(counts).sort()).toEqual(
        ['grid', 'health-factor', 'monitoring', 'other', 'rebalancing', 'yield'].sort(),
      );
    });

    it('counts only verified-live agents when asked, and none are without probes', async () => {
      await catalog.upsertAgents([record(1n, 'grid'), record(2n, 'yield')]);

      expect((await catalog.categoryCounts('bsc-testnet')).grid).toBe(1);
      // No probes recorded, so nothing is verified live - which is the honest
      // answer and the one the default view shows.
      const live = await catalog.categoryCounts('bsc-testnet', { verifiedLiveOnly: true });
      expect(live.grid).toBe(0);
      expect(live.yield).toBe(0);
    });
  });
});
