import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { VERIFIED_LIVE, type Address, type AgentRecord, type ProbeResult } from '@bench/core';
import { createDb, PgCatalogRepository, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

/**
 * The denominator of the headline claim.
 *
 * It must not be movable by the prober's scheduling. The version that required
 * a verdict inside six hours was: the prober refreshes conformant endpoints
 * first, so live verdicts stayed current while dead ones aged out of the set,
 * and the published share went to 0.9% against 0.17% measured by sampling the
 * same band of the registry.
 */
const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;
const OWNER = '0x3333333333333333333333333333333333333333' as Address;

const record = (tokenId: bigint): AgentRecord => ({
  id: { chain: 'bsc-testnet', tokenId },
  owner: OWNER,
  cardUri: `ipfs://card/${tokenId}`,
  card: {
    name: `agent ${tokenId}`,
    description: '',
    category: 'other',
    endpoints: [{ protocol: 'a2a', url: `https://agent-${tokenId}.example/a2a` }],
    permissions: { contractAllowlist: [], requiresTokenApprovals: false },
    raw: {},
  },
  registeredAt: new Date('2026-08-01T00:00:00.000Z'),
});

const probe = (tokenId: bigint, at: Date, conformant: boolean): ProbeResult => ({
  agent: { chain: 'bsc-testnet', tokenId },
  endpoint: { protocol: 'a2a', url: `https://agent-${tokenId}.example/a2a` },
  at,
  reachable: true,
  latencyMs: 20,
  conformant,
});

describeDb('verdictCount', () => {
  const db = createDb(URL ?? '', { isolate: true });
  const catalog = new PgCatalogRepository(db);

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });

  beforeEach(async () => {
    await db.delete(schema.probeResults);
    await db.delete(schema.agentEndpoints);
    await db.delete(schema.agents);
  });

  afterAll(async () => {
    /**
     * Clean up, because this database is shared with more than these tests.
     *
     * CI runs `npm test` and then `npm run db:seed` against the same Postgres,
     * and the seed's self-check measures every agent on the chain. Rows left
     * here - deliberately including one fresh, conformant, verified-live agent
     * - turned up in that count and failed the seed with a message about SQL
     * disagreeing with TypeScript, which was not what had happened.
     *
     * `beforeEach` was never enough on its own: it clears the table before each
     * case, so whatever the *last* case wrote survives the file.
     */
    await db.delete(schema.probeResults);
    await db.delete(schema.agentEndpoints);
    await db.delete(schema.agents);
    await db.$client.end();
  });

  const settle = async (tokenId: bigint, at: Date, conformant: boolean): Promise<void> => {
    for (let i = 0; i < VERIFIED_LIVE.minProbeCount; i += 1) {
      await catalog.recordProbe(probe(tokenId, new Date(at.getTime() + i * 1_000), conformant));
    }
  };

  it('counts an agent once it has been tested, not once per probe', async () => {
    await catalog.upsertAgents([record(1n), record(2n)]);
    await settle(1n, new Date(), true);
    expect(await catalog.verdictCount('bsc-testnet')).toBe(1);
  });

  it('does not count an agent still short of a verdict', async () => {
    await catalog.upsertAgents([record(1n)]);
    await catalog.recordProbe(probe(1n, new Date(), true));
    expect(await catalog.verdictCount('bsc-testnet')).toBe(0);
  });

  it('keeps a stale verdict in the denominator', async () => {
    /**
     * The bug. A dead endpoint sinks to the back of the probe queue and its
     * verdict ages; a live one is refreshed first and stays current. If
     * staleness removed an agent from this count, the prober would be choosing
     * the denominator and the share would report its own scheduling.
     */
    const longAgo = new Date(Date.now() - 5 * VERIFIED_LIVE.maxProbeAgeMs);
    await catalog.upsertAgents([record(1n), record(2n)]);
    await settle(1n, new Date(), true); // live, freshly refreshed
    await settle(2n, longAgo, false); // dead, left to go stale

    expect(await catalog.verdictCount('bsc-testnet')).toBe(2);
    // And the numerator still requires recency, which is the asymmetry the
    // number depends on: tested need not mean lately, live must mean now.
    expect((await catalog.stats('bsc-testnet')).verifiedLive).toBe(1);
  });
});
