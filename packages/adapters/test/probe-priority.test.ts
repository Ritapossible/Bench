import { describe, expect, it } from 'vitest';
import type { AgentCard, AgentRecord, ProbeResult } from '@bench/core';
import { InMemoryCatalogRepository } from '../src/fakes.js';

/**
 * The scheduling rule that decides whether "verified live" can ever be
 * non-zero.
 *
 * A verdict needs three probes. Ordering the due list by recency alone puts
 * every never-probed endpoint ahead of one probed twice - and the indexer adds
 * thousands of never-probed endpoints a day, so the backlog never empties and
 * no endpoint ever reaches three. Measured in production: 6,008 agents
 * indexed, an endpoint answering in 276ms with 100% uptime, one probe on it,
 * and the site reporting nought verified live.
 */
const card = (url: string): AgentCard => ({
  name: url,
  description: '',
  category: 'other',
  endpoints: [{ protocol: 'a2a', url }],
  permissions: { contractAllowlist: [], requiresTokenApprovals: false },
  raw: {},
});

const record = (tokenId: bigint, url: string): AgentRecord => ({
  id: { chain: 'bsc-mainnet', tokenId },
  owner: `0x${'11'.repeat(20)}`,
  cardUri: url,
  card: card(url),
  registeredAt: new Date(0),
});

const probe = (tokenId: bigint, url: string, at: Date): ProbeResult => ({
  agent: { chain: 'bsc-mainnet', tokenId },
  endpoint: { protocol: 'a2a', url },
  at,
  reachable: true,
  conformant: true,
  latencyMs: 10,
});

const BOOTSTRAP = { afterMs: 2 * 60 * 1000, untilProbeCount: 3 };

describe('dueForProbe priority', () => {
  it('finishes a verdict before starting new ones', async () => {
    const started = record(1n, 'https://started.example/a2a');
    const untouched = Array.from({ length: 50 }, (_, i) =>
      record(BigInt(100 + i), `https://cold${i}.example/a2a`),
    );
    const repo = new InMemoryCatalogRepository([started, ...untouched]);
    // Probed once, ten minutes ago: past the bootstrap cadence, short of a
    // verdict, and the least recent thing in the catalog that has any history.
    await repo.recordProbe(
      probe(1n, 'https://started.example/a2a', new Date(Date.now() - 10 * 60 * 1000)),
    );

    const due = await repo.dueForProbe(5, 60 * 60 * 1000, BOOTSTRAP);
    expect(due[0]?.agent.tokenId).toBe(1n);
  });

  it('still reaches unprobed endpoints once verdicts are settled', async () => {
    const settled = record(1n, 'https://settled.example/a2a');
    const fresh = record(2n, 'https://fresh.example/a2a');
    const repo = new InMemoryCatalogRepository([settled, fresh]);
    const old = Date.now() - 10 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      await repo.recordProbe(probe(1n, 'https://settled.example/a2a', new Date(old + i)));
    }

    const due = await repo.dueForProbe(5, 60 * 60 * 1000, BOOTSTRAP);
    // The settled one is not stale yet, so it is not even due; the unprobed
    // one is, and nothing outranks it.
    expect(due.map((d) => d.agent.tokenId)).toEqual([2n]);
  });

  it('gives no refresh priority to an endpoint that never spoke its protocol', async () => {
    const dead = record(1n, 'https://dead.example/a2a');
    const fresh = record(2n, 'https://fresh.example/a2a');
    const repo = new InMemoryCatalogRepository([dead, fresh]);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      await repo.recordProbe({
        ...probe(1n, 'https://dead.example/a2a', new Date(old + i)),
        conformant: false,
      });
    }

    const due = await repo.dueForProbe(5, 60 * 60 * 1000, BOOTSTRAP);
    // Reachable is not conformant, and only a verdict of "live" can expire.
    expect(due.map((d) => d.agent.tokenId)).toEqual([2n, 1n]);
  });

  it('refreshes a verdict that expires before starting a new one', async () => {
    // Mirrors the SQL. "Verified live" means probed inside six hours, so an
    // endpoint that has conformed holds something that can go stale; tens of
    // thousands of never-probed ones in front of it is how the verified count
    // fell from 44 to 23 overnight while every one of them was still up.
    const settled = record(1n, 'https://settled.example/a2a');
    const fresh = record(2n, 'https://fresh.example/a2a');
    const repo = new InMemoryCatalogRepository([settled, fresh]);
    const old = Date.now() - 2 * 60 * 60 * 1000;
    for (let i = 0; i < 3; i += 1) {
      await repo.recordProbe(probe(1n, 'https://settled.example/a2a', new Date(old + i)));
    }

    const due = await repo.dueForProbe(5, 60 * 60 * 1000, BOOTSTRAP);
    expect(due[0]?.agent.tokenId).toBe(1n);
    expect(due.map((d) => d.agent.tokenId)).toEqual([1n, 2n]);
  });

  it('does not hold back an endpoint probed inside the bootstrap window', async () => {
    const justProbed = record(1n, 'https://just.example/a2a');
    const repo = new InMemoryCatalogRepository([justProbed]);
    await repo.recordProbe(probe(1n, 'https://just.example/a2a', new Date(Date.now() - 5_000)));
    expect(await repo.dueForProbe(5, 60 * 60 * 1000, BOOTSTRAP)).toHaveLength(0);
  });
});
