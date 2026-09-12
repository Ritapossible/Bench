import {
  BenchError,
  type AgentCard,
  type AgentRecord,
  type CatalogRepository,
  type ChainName,
  type Hex,
  type IndexerCheckpoint,
  type ListAgentsQuery,
  type RegistryClient,
} from '@bench/core';
import { describe, expect, it } from 'vitest';
import { Indexer } from '../src/indexer.js';

/**
 * The indexer's defining behaviour is what it does with *failure*: roughly 96%
 * of BSC registrations will not produce a usable card, and those agents have
 * to stay in the catalog. They are the denominator of the density figure Bench
 * publishes — dropping them would turn an honest "4% are real" into a
 * meaningless "100% of what we kept are real".
 */

const record = (tokenId: bigint, cardUri: string): AgentRecord => ({
  id: { chain: 'bsc-testnet', tokenId },
  owner: `0x${'11'.repeat(20)}`,
  cardUri,
  card: null,
  registeredAt: new Date('2026-08-01T00:00:00Z'),
});

const card = (name: string): AgentCard => ({
  name,
  description: '',
  category: 'yield',
  endpoints: [{ protocol: 'a2a', url: 'https://a.example/a2a' }],
  permissions: { contractAllowlist: [], requiresTokenApprovals: false },
  raw: {},
});

class StubRegistry implements RegistryClient {
  lastQuery: ListAgentsQuery | undefined;
  head = 1_000n;

  constructor(
    private readonly agents: readonly AgentRecord[] = [],
    private readonly cards = new Map<string, AgentCard>(),
  ) {}

  async headBlock(): Promise<bigint> {
    return this.head;
  }
  async headTokenId(): Promise<bigint> {
    return this.agents.reduce((hi, a) => (a.id.tokenId > hi ? a.id.tokenId : hi), 0n);
  }
  async readTokenRange(from: bigint, to: bigint): Promise<readonly AgentRecord[]> {
    return [...this.agents]
      .filter((a) => a.id.tokenId >= from && a.id.tokenId <= to)
      .sort((a, b) => (a.id.tokenId < b.id.tokenId ? -1 : 1));
  }
  async listAgents(q?: ListAgentsQuery): Promise<readonly AgentRecord[]> {
    this.lastQuery = q;
    return this.agents;
  }
  async getAgent(): Promise<AgentRecord | null> {
    return null;
  }
  async enumerateAgents(opts: { fromTokenId?: bigint; limit?: number } = {}) {
    const from = opts.fromTokenId ?? 0n;
    const picked = this.agents.filter((a) => a.id.tokenId >= from).slice(0, opts.limit ?? 500);
    const last = picked[picked.length - 1]?.id.tokenId ?? (from > 0n ? from - 1n : 0n);
    return { agents: picked, lastTokenId: last, reachedEnd: true };
  }
  async resolveCard(uri: string): Promise<AgentCard> {
    const c = this.cards.get(uri);
    if (!c) throw new BenchError('INVALID_AGENT_CARD', `no card at ${uri}`);
    return c;
  }
  async watchRegistrations(): Promise<() => void> {
    return () => {};
  }
  async writeValidation(): Promise<Hex> {
    return `0x${'11'.repeat(32)}`;
  }
  async anchorProbeDigest(): Promise<Hex> {
    return `0x${'22'.repeat(32)}`;
  }
}

/** Only the methods the indexer touches; the rest throw if ever reached. */
class StubRepo implements Partial<CatalogRepository> {
  readonly stored = new Map<string, AgentRecord>();
  readonly checkpoints = new Map<ChainName, IndexerCheckpoint>();

  async upsertAgents(records: readonly AgentRecord[]): Promise<number> {
    for (const r of records) this.stored.set(`${r.id.chain}:${r.id.tokenId}`, r);
    return records.length;
  }
  async checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null> {
    return this.checkpoints.get(chain) ?? null;
  }
  async setCheckpoint(chain: ChainName, lastBlock: bigint): Promise<void> {
    const prev = this.checkpoints.get(chain);
    this.checkpoints.set(chain, {
      chain,
      lastBlock,
      lastTokenId: prev?.lastTokenId ?? null,
      updatedAt: new Date(),
    });
  }
  async setTokenCursor(chain: ChainName, lastTokenId: bigint): Promise<void> {
    const prev = this.checkpoints.get(chain);
    this.checkpoints.set(chain, {
      chain,
      lastBlock: prev?.lastBlock ?? 0n,
      lastTokenId,
      updatedAt: new Date(),
    });
  }
}

const build = (registry: StubRegistry, repo: StubRepo, over = {}) =>
  new Indexer(registry, repo as unknown as CatalogRepository, {
    chain: 'bsc-testnet',
    startBlock: 0n,
    confirmations: 15n,
    ...over,
  });

describe('Indexer', () => {
  it('keeps agents whose card fails to resolve', async () => {
    const registry = new StubRegistry(
      [record(1n, 'ipfs://good'), record(2n, 'ipfs://dead')],
      new Map([['ipfs://good', card('Live One')]]),
    );
    const repo = new StubRepo();

    const r = await build(registry, repo).tick(1_000n);

    expect(r.discovered).toBe(2);
    expect(r.cardsResolved).toBe(1);
    expect(r.cardsFailed).toBe(1);
    expect(repo.stored.size).toBe(2);
  });

  it('records why a card failed, not just that it did', async () => {
    const registry = new StubRegistry([record(2n, 'ipfs://dead')]);
    const repo = new StubRepo();

    await build(registry, repo).tick(1_000n);

    const stored = repo.stored.get('bsc-testnet:2');
    expect(stored?.card).toBeNull();
    expect(stored?.cardError).toMatch(/no card at/);
  });

  it('distinguishes "no tokenURI" from "tokenURI did not resolve"', async () => {
    const registry = new StubRegistry([record(3n, '')]);
    const repo = new StubRepo();

    await build(registry, repo).tick(1_000n);

    expect(repo.stored.get('bsc-testnet:3')?.cardError).toBe('no tokenURI');
  });

  it('stays behind head by the confirmation lag', async () => {
    // Indexing into a block that later gets orphaned writes an agent that
    // never existed. Re-reading a few blocks is cheap; a phantom is not.
    const repo = new StubRepo();
    const r = await build(new StubRegistry(), repo).tick(1_000n);

    expect(r.toBlock).toBe(985n);
    expect(repo.checkpoints.get('bsc-testnet')?.lastBlock).toBe(985n);
  });

  it('resumes from the checkpoint rather than from startBlock', async () => {
    const repo = new StubRepo();
    await repo.setCheckpoint('bsc-testnet', 500n);

    const r = await build(new StubRegistry(), repo).tick(1_000n);

    expect(r.fromBlock).toBe(501n);
  });

  it('is a clean no-op when already caught up', async () => {
    const registry = new StubRegistry([record(1n, 'ipfs://x')]);
    const repo = new StubRepo();
    await repo.setCheckpoint('bsc-testnet', 990n);

    const r = await build(registry, repo).tick(1_000n);

    expect(r.discovered).toBe(0);
    expect(repo.stored.size).toBe(0);
    // Must not have asked the registry for a backwards range.
    expect(registry.lastQuery).toBeUndefined();
  });

  it('does not advance the checkpoint when the write fails', async () => {
    // Checkpointing before the upsert lands would turn one failed write into
    // a permanently skipped block range.
    const repo = new StubRepo();
    repo.upsertAgents = async () => {
      throw new Error('postgres down');
    };

    await expect(
      build(new StubRegistry([record(1n, 'ipfs://x')]), repo).tick(1_000n),
    ).rejects.toThrow(/postgres down/);
    expect(repo.checkpoints.get('bsc-testnet')).toBeUndefined();
  });
});

describe('enumerationTick', () => {
  const agents = [record(0n, 'ipfs://good'), record(1n, 'ipfs://dead'), record(2n, 'ipfs://good')];
  const cards = new Map([['ipfs://good', card('Live One')]]);

  it('walks token ids, resolves cards, and advances the token cursor', async () => {
    const repo = new StubRepo();
    const indexer = build(new StubRegistry(agents, cards), repo);

    const r = await indexer.enumerationTick();

    expect(r.discovered).toBe(3);
    expect(r.upserted).toBe(3);
    expect(r.cardsResolved).toBe(2);
    // The agent whose card 404s is kept, exactly as in the log path: it is the
    // denominator of the density figure.
    expect(r.cardsFailed).toBe(1);
    expect(repo.stored.size).toBe(3);
    expect((await repo.checkpoint('bsc-testnet'))?.lastTokenId).toBe(2n);
  });

  it('resumes at the cursor rather than rewalking from zero', async () => {
    const repo = new StubRepo();
    const indexer = build(new StubRegistry(agents, cards), repo);

    await indexer.enumerationTick();
    const second = await indexer.enumerationTick();

    // Resumes *at* the last id, not past it. Re-reading one agent is free
    // under an upsert by (chain, tokenId), and it gives a card that failed to
    // resolve last time another attempt.
    expect(second.fromTokenId).toBe(2n);
  });

  it('leaves the block cursor alone', async () => {
    // The two cursors resume different things. Moving the block cursor here
    // would make a later log scan skip every block in between.
    const repo = new StubRepo();
    const indexer = build(new StubRegistry(agents, cards), repo);

    await indexer.enumerationTick();

    expect((await repo.checkpoint('bsc-testnet'))?.lastBlock).toBe(0n);
  });

  it('does not advance the cursor when the registry is empty', async () => {
    const repo = new StubRepo();
    const indexer = build(new StubRegistry([], cards), repo);

    const r = await indexer.enumerationTick();

    expect(r.discovered).toBe(0);
    expect(await repo.checkpoint('bsc-testnet')).toBeNull();
  });
});

describe('Indexer re-sweep', () => {
  /**
   * Enumeration resumed from a cursor and stopped at the end of the registry,
   * so an agent indexed once was never read again. When `inferCategory` was
   * fixed so `rebalancing` could be produced at all, all 2,060 already-indexed
   * agents would have kept their old category forever.
   */
  class SweepRepo implements Partial<CatalogRepository> {
    cursor: bigint | null = null;
    readonly cursorWrites: bigint[] = [];
    async checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null> {
      return { chain, lastBlock: 0n, lastTokenId: this.cursor, updatedAt: new Date(0) };
    }
    async setTokenCursor(_chain: ChainName, id: bigint): Promise<void> {
      this.cursor = id;
      this.cursorWrites.push(id);
    }
    async upsertAgents(): Promise<number> {
      return 0;
    }
  }

  /**
   * A caught-up registry. Note it returns one agent, not zero: enumeration
   * deliberately re-reads the token it starts on, so the empty case only
   * happens on an empty registry - which is why an earlier version of the
   * re-sweep, keyed on finding no agents, never once fired in production.
   */
  const registryAtEnd = {
    enumerateAgents: async ({ fromTokenId }: { fromTokenId: bigint }) => ({
      agents: [
        {
          id: { chain: 'bsc-testnet' as const, tokenId: fromTokenId },
          owner: '0x1111111111111111111111111111111111111111' as const,
          cardUri: 'data:application/json,{}',
          card: null,
          registeredAt: new Date(0),
        },
      ],
      lastTokenId: fromTokenId,
      reachedEnd: true,
    }),
  } as unknown as RegistryClient;

  const build = (repo: SweepRepo, opts = {}) =>
    new Indexer(registryAtEnd, repo as unknown as CatalogRepository, {
      chain: 'bsc-testnet',
      startBlock: 0n,
      ...opts,
    });

  it('rewinds on the first pass after start, when the parser may have changed', async () => {
    // A restart is exactly when new parsing code is running, which is exactly
    // when every existing card needs reading again.
    const repo = new SweepRepo();
    repo.cursor = 100n;
    const r = await build(repo).enumerationTick();
    expect(r.resweeping).toBe(true);
    expect(repo.cursor).toBe(0n);
  });

  it('does not rewind again before the interval is up', async () => {
    // Re-reading the whole registry on a loop would mean ~700 HTTP fetches
    // against strangers' hosts every couple of minutes.
    const repo = new SweepRepo();
    repo.cursor = 100n;
    const indexer = build(repo, { resweepAfterMs: 60_000 });
    expect((await indexer.enumerationTick()).resweeping).toBe(true);
    expect((await indexer.enumerationTick()).resweeping).toBe(false);
    expect((await indexer.enumerationTick()).resweeping).toBe(false);
  });

  it('never rewinds mid-pass', async () => {
    // Rewinding before the end would re-read the front of the registry forever
    // and never reach the back.
    const repo = new SweepRepo();
    const midPass = {
      enumerateAgents: async () => ({ agents: [], lastTokenId: 50n, reachedEnd: false }),
    } as unknown as RegistryClient;
    const indexer = new Indexer(midPass, repo as unknown as CatalogRepository, {
      chain: 'bsc-testnet',
      startBlock: 0n,
    });
    expect((await indexer.enumerationTick()).resweeping).toBe(false);
    expect(repo.cursorWrites).toEqual([]);
  });
});
