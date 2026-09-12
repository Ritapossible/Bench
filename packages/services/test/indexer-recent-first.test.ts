import { describe, expect, it } from 'vitest';
import type { AgentCard, AgentRecord, RegistryClient } from '@bench/core';
import { Indexer } from '../src/indexer.js';
import { InMemoryCatalogRepository } from '@bench/adapters';

/**
 * Order matters because the useful end of this registry is the recent end.
 * Measured on BSC mainnet: the oldest 28,000 registrations declare a callable
 * endpoint 1.27% of the time and none of 1,500 sampled answered their own
 * protocol, against 11.40% and 0.45% registry-wide. Ascending, the catalog
 * spends its first thirteen hours publishing the deadest slice there is.
 */
const card: AgentCard = {
  name: 'a',
  description: '',
  category: 'other',
  endpoints: [],
  permissions: { contractAllowlist: [], requiresTokenApprovals: false },
  raw: {},
};

const record = (tokenId: bigint): AgentRecord => ({
  id: { chain: 'bsc-mainnet', tokenId },
  owner: `0x${'11'.repeat(20)}`,
  cardUri: `data:${tokenId}`,
  card: null,
  registeredAt: new Date(0),
});

class Registry implements Partial<RegistryClient> {
  readonly reads: { from: bigint; to: bigint }[] = [];
  constructor(public head: bigint) {}
  async headTokenId(): Promise<bigint> {
    return this.head;
  }
  async readTokenRange(from: bigint, to: bigint): Promise<readonly AgentRecord[]> {
    this.reads.push({ from, to });
    const out: AgentRecord[] = [];
    for (let i = from; i <= to; i += 1n) out.push(record(i));
    return out;
  }
  async resolveCard(): Promise<AgentCard> {
    return card;
  }
}

const build = (reg: Registry) =>
  new Indexer(reg as unknown as RegistryClient, new InMemoryCatalogRepository(), {
    chain: 'bsc-mainnet',
    startBlock: 0n,
    batchSize: 100,
  });

describe('recentFirstTick', () => {
  it('starts at the head, not at zero', async () => {
    const reg = new Registry(10_000n);
    const r = await build(reg).recentFirstTick();
    expect(r.lastTokenId).toBe(10_000n);
    expect(r.fromTokenId).toBe(9_901n);
  });

  it('walks downward on subsequent ticks', async () => {
    const reg = new Registry(10_000n);
    const ix = build(reg);
    await ix.recentFirstTick();
    const second = await ix.recentFirstTick();
    expect(second.lastTokenId).toBe(9_900n);
    expect(second.fromTokenId).toBe(9_801n);
  });

  it('refreshes the top on the first tick after a restart', async () => {
    // New registrations arrive above the head - about 2,000 a day here - so a
    // restart should see them before finishing a descent that takes hours.
    const reg = new Registry(10_000n);
    const first = build(reg);
    await first.recentFirstTick();
    await first.recentFirstTick();
    reg.head = 10_500n;
    const afterRestart = await build(reg).recentFirstTick();
    expect(afterRestart.lastTokenId).toBe(10_500n);
  });

  it('never reads below zero', async () => {
    const reg = new Registry(40n);
    const r = await build(reg).recentFirstTick();
    expect(r.fromTokenId).toBe(0n);
    expect(r.reachedEnd).toBe(true);
  });

  it('starts again from the head once it has reached the bottom', async () => {
    const reg = new Registry(150n);
    const ix = build(reg);
    await ix.recentFirstTick(); // 51..150
    const bottom = await ix.recentFirstTick(); // 0..50
    expect(bottom.reachedEnd).toBe(true);
    reg.head = 200n;
    const wrapped = await ix.recentFirstTick();
    expect(wrapped.lastTokenId).toBe(200n);
  });

  it('indexes what it reads', async () => {
    const reg = new Registry(500n);
    const r = await build(reg).recentFirstTick();
    expect(r.discovered).toBe(100);
    expect(r.upserted).toBe(100);
    expect(r.cardsResolved).toBe(100);
  });
});
