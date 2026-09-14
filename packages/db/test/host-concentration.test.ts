import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { VERIFIED_LIVE, type Address, type AgentRecord, type ProbeResult } from '@bench/core';
import { createDb, PgCatalogRepository, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

/**
 * The qualifier on the headline live count.
 *
 * A large share of this catalog's verified-live agents are one platform's
 * hosted runtime: separate identity NFTs, separate owners, sequential platform
 * ids, a single endpoint. Every probe saying those are up is the same probe
 * against the same machine, so the count answers "how many responses" while
 * reading as "how many independent services". This is the measurement that
 * lets the page say so.
 */
const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;
const OWNER = '0x4444444444444444444444444444444444444444' as Address;

const record = (
  tokenId: bigint,
  endpoints: readonly { protocol: 'a2a' | 'mcp'; url: string }[],
): AgentRecord => ({
  id: { chain: 'bsc-testnet', tokenId },
  owner: OWNER,
  cardUri: `ipfs://card/${tokenId}`,
  card: {
    name: `agent ${tokenId}`,
    description: '',
    category: 'other',
    endpoints: [...endpoints],
    permissions: { contractAllowlist: [], requiresTokenApprovals: false },
    raw: {},
  },
  registeredAt: new Date('2026-08-01T00:00:00.000Z'),
});

const probe = (tokenId: bigint, url: string, at: Date): ProbeResult => ({
  agent: { chain: 'bsc-testnet', tokenId },
  endpoint: { protocol: 'a2a', url },
  at,
  reachable: true,
  latencyMs: 20,
  conformant: true,
});

describeDb('hostConcentration', () => {
  const db = createDb(URL ?? '', { isolate: true });
  const catalog = new PgCatalogRepository(db);

  const wipe = async (): Promise<void> => {
    await db.delete(schema.probeResults);
    await db.delete(schema.agentEndpoints);
    await db.delete(schema.agents);
  };

  beforeAll(async () => {
    await runMigrations(URL ?? '');
  });
  beforeEach(wipe);
  afterAll(async () => {
    // Shared Postgres: CI seeds against it after this file runs, and the seed's
    // self-check measures every agent on the chain.
    await wipe();
    await db.$client.end();
  });

  const settle = async (tokenId: bigint, url: string): Promise<void> => {
    const at = new Date();
    for (let i = 0; i < VERIFIED_LIVE.minProbeCount; i += 1) {
      await catalog.recordProbe(probe(tokenId, url, new Date(at.getTime() + i * 1_000)));
    }
  };

  it('counts distinct agents behind one host', async () => {
    await catalog.upsertAgents([
      record(1n, [{ protocol: 'a2a', url: 'https://app.example.org/agents/1/card.json' }]),
      record(2n, [{ protocol: 'a2a', url: 'https://app.example.org/agents/2/card.json' }]),
      record(3n, [{ protocol: 'a2a', url: 'https://alone.example/a2a' }]),
    ]);
    await settle(1n, 'https://app.example.org/agents/1/card.json');
    await settle(2n, 'https://app.example.org/agents/2/card.json');
    await settle(3n, 'https://alone.example/a2a');

    const hosts = await catalog.hostConcentration('bsc-testnet');
    expect(hosts[0]).toEqual({ host: 'app.example.org', agents: 2 });
    expect(hosts.find((h) => h.host === 'alone.example')?.agents).toBe(1);
  });

  it('counts an agent once however many endpoints it declares there', async () => {
    /**
     * `countDistinct`, not `count`. An agent publishing both an A2A card and an
     * MCP endpoint on one host is one agent on that host, and counting rows
     * would report it twice - inflating the exact number this exists to
     * deflate.
     */
    await catalog.upsertAgents([
      record(1n, [
        { protocol: 'a2a', url: 'https://app.example.org/agents/1/card.json' },
        { protocol: 'mcp', url: 'https://app.example.org/api/mcp' },
      ]),
    ]);
    await settle(1n, 'https://app.example.org/agents/1/card.json');

    const hosts = await catalog.hostConcentration('bsc-testnet');
    expect(hosts).toEqual([{ host: 'app.example.org', agents: 1 }]);
  });

  it('ignores agents that are not verified live', async () => {
    // The claim being qualified is the live one. Hosts that never answer
    // concentrate too, and nothing rests on it.
    await catalog.upsertAgents([
      record(1n, [{ protocol: 'a2a', url: 'https://app.example.org/agents/1/card.json' }]),
      record(2n, [{ protocol: 'a2a', url: 'https://app.example.org/agents/2/card.json' }]),
    ]);
    await settle(1n, 'https://app.example.org/agents/1/card.json');

    expect(await catalog.hostConcentration('bsc-testnet')).toEqual([
      { host: 'app.example.org', agents: 1 },
    ]);
  });

  it('reads one host out of a port, a path and a capital letter', async () => {
    // `example.com` and `EXAMPLE.com:443` are one host. Two spellings counted
    // separately would split a concentrated platform into several unremarkable
    // ones, which is the failure that hides what this measures.
    await catalog.upsertAgents([
      record(1n, [{ protocol: 'a2a', url: 'https://App.Example.org:443/agents/1/card.json' }]),
      record(2n, [{ protocol: 'a2a', url: 'https://app.example.org/api/mcp' }]),
    ]);
    await settle(1n, 'https://App.Example.org:443/agents/1/card.json');
    await settle(2n, 'https://app.example.org/api/mcp');

    expect(await catalog.hostConcentration('bsc-testnet')).toEqual([
      { host: 'app.example.org', agents: 2 },
    ]);
  });
});
