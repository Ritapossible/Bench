import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Address, AgentCard, AgentRecord } from '@bench/core';
import { eq } from 'drizzle-orm';
import { createDb, PgCatalogRepository, runMigrations } from '../src/index.js';
import * as schema from '../src/schema.js';

/**
 * `raw` is the whole original registration, kept so a later parser could
 * re-mine indexed cards without re-fetching. A fair trade at 2,400 testnet
 * agents; at 345,879 mainnet ones it was the largest thing in the database and
 * it hit a 512 MB ceiling - every write failing with "could not extend file",
 * the prober unable to record a probe, and the catalog reporting zero
 * verified-live agents because liveness could not be refreshed rather than
 * because anything had died.
 */
const URL = process.env['TEST_DATABASE_URL'];
const describeDb = URL === undefined || URL === '' ? describe.skip : describe;

const bulky = {
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
  name: 'A',
  description: 'x'.repeat(4_000),
  services: [{ name: 'A2A', endpoint: 'https://a.example/a2a' }],
  somethingNobodyParses: 'y'.repeat(4_000),
};

const card: AgentCard = {
  name: 'A',
  description: 'short',
  category: 'other',
  endpoints: [{ protocol: 'a2a', url: 'https://a.example/a2a' }],
  permissions: { contractAllowlist: [], requiresTokenApprovals: false },
  image: 'https://a.example/logo.png',
  raw: bulky,
};

const record: AgentRecord = {
  id: { chain: 'bsc-mainnet', tokenId: 345_879n },
  owner: `0x${'33'.repeat(20)}` as Address,
  cardUri: 'ipfs://Qm',
  card,
  registeredAt: new Date('2026-09-13T00:00:00.000Z'),
};

describeDb('what a stored card keeps', () => {
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
    await db.$client.end();
  });

  it('does not persist raw', async () => {
    await catalog.upsertAgents([record]);
    const [row] = await db.select().from(schema.agents);
    expect(row?.card).not.toHaveProperty('raw');
  });

  it('keeps everything the catalog actually renders', async () => {
    await catalog.upsertAgents([record]);
    const [row] = await db.select().from(schema.agents);
    const stored = row?.card as AgentCard;
    expect(stored.name).toBe('A');
    expect(stored.description).toBe('short');
    expect(stored.category).toBe('other');
    expect(stored.image).toBe('https://a.example/logo.png');
    expect(stored.endpoints).toHaveLength(1);
  });

  it('reads back as a card, with raw null rather than absent', async () => {
    await catalog.upsertAgents([record]);
    const got = await catalog.getAgent(record.id);
    expect(got?.card?.name).toBe('A');
    expect(got?.card?.raw).toBeNull();
  });

  it('stores a fraction of what the registration weighed', async () => {
    await catalog.upsertAgents([record]);
    const [row] = await db.select().from(schema.agents);
    const stored = JSON.stringify(row?.card).length;
    // The blob alone is over 8 KB; what is kept is the part something reads.
    expect(JSON.stringify(bulky).length).toBeGreaterThan(8_000);
    expect(stored).toBeLessThan(500);
  });

  it('keeps only a name when the card declares nothing callable', async () => {
    // 88.6% of mainnet registrations are this shape. They cannot be probed,
    // auditioned or hired, and their descriptions were the largest remaining
    // weight in the table.
    const inert: AgentRecord = {
      ...record,
      id: { chain: 'bsc-mainnet', tokenId: 99n },
      card: { ...card, endpoints: [], description: 'z'.repeat(3_000) },
    };
    await catalog.upsertAgents([inert]);
    const [row] = await db.select().from(schema.agents).where(eq(schema.agents.tokenId, '99'));
    const stored = row?.card as AgentCard;
    expect(stored.name).toBe('A');
    expect(stored.description).toBe('');
    expect(JSON.stringify(stored).length).toBeLessThan(200);
  });

  it('still counts as a resolvable card, because that is a denominator', async () => {
    // "345,879 registered, 271,479 with a resolvable card" are count(*) and
    // count(card is not null) over this table. Trimming a card must not turn
    // it into a null one, or the figure that makes "0.45% live" mean anything
    // quietly drops by a quarter of a million.
    await catalog.upsertAgents([
      { ...record, id: { chain: 'bsc-mainnet', tokenId: 98n }, card: { ...card, endpoints: [] } },
    ]);
    const stats = await catalog.stats('bsc-mainnet');
    expect(stats.withResolvableCard).toBe(stats.registered);
  });
});
