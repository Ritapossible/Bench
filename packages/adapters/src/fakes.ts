import {
  BenchError,
  isVerifiedLive,
  summarizeProbes,
  type AgentCard,
  type AgentId,
  type AgentRecord,
  type CatalogEntry,
  type CatalogPage,
  type CatalogQuery,
  type CatalogRepository,
  type CatalogStats,
  type ChainName,
  type Hex,
  type IndexerCheckpoint,
  type EnumerateOptions,
  type EnumerationResult,
  type ListAgentsQuery,
  type LivenessSummary,
  type ProbeResult,
  type ProbeTarget,
  type RegistryClient,
  type ValidationEntry,
} from '@bench/core';

/**
 * In-memory fakes so Phases 1–3 can be built and tested with no chain, no
 * testnet funds, and no SDK. Every fake satisfies the same port as the real
 * adapter, so swapping between them is a factory decision, not a code change.
 *
 * These are for tests and local development only — never exported from the
 * production factory.
 */
export class FakeRegistryClient implements RegistryClient {
  readonly writes: ValidationEntry[] = [];
  readonly anchors: Hex[] = [];
  /** Settable so tests can drive the indexer's confirmation lag. */
  head = 1_000n;

  constructor(
    private readonly agents: AgentRecord[] = [],
    private readonly cards: Map<string, AgentCard> = new Map(),
  ) {}

  async headBlock(): Promise<bigint> {
    return this.head;
  }

  async listAgents(q?: ListAgentsQuery): Promise<readonly AgentRecord[]> {
    return this.agents.slice(0, q?.limit ?? this.agents.length);
  }

  /** Token-id order, and the same gap semantics as the real walk. */
  async enumerateAgents(opts: EnumerateOptions = {}): Promise<EnumerationResult> {
    const from = opts.fromTokenId ?? 0n;
    const limit = opts.limit ?? this.agents.length;
    const sorted = [...this.agents].sort((a, b) => (a.id.tokenId < b.id.tokenId ? -1 : 1));
    const agents = sorted.filter((a) => a.id.tokenId >= from).slice(0, limit);
    const last = agents[agents.length - 1]?.id.tokenId ?? (from > 0n ? from - 1n : 0n);
    return { agents, lastTokenId: last, reachedEnd: agents.length < limit };
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    return this.agents.find((a) => a.id.tokenId === id.tokenId && a.id.chain === id.chain) ?? null;
  }

  async resolveCard(uri: string): Promise<AgentCard> {
    const card = this.cards.get(uri);
    if (!card) {
      // Mirrors reality: most cards do not resolve. Callers must handle this.
      throw new BenchError('INVALID_AGENT_CARD', `no card at ${uri}`);
    }
    return card;
  }

  async watchRegistrations(
    _fromBlock: bigint,
    _onAgent: (a: AgentRecord) => Promise<void>,
  ): Promise<() => void> {
    return () => {};
  }

  async writeValidation(entry: ValidationEntry): Promise<Hex> {
    this.writes.push(entry);
    return `0x${'11'.repeat(32)}`;
  }

  async anchorProbeDigest(digest: Hex): Promise<Hex> {
    this.anchors.push(digest);
    return `0x${'22'.repeat(32)}`;
  }
}

const agentKey = (id: AgentId): string => `${id.chain}:${id.tokenId.toString()}`;

/**
 * In-memory CatalogRepository.
 *
 * Not only a test double — it is what lets the indexer, prober, and anchor be
 * developed and demoed with no Postgres running. The Drizzle implementation in
 * @bench/db satisfies the same port, so moving between them is a wiring
 * change. Where semantics could drift between the two (probe retention,
 * cursor meaning, verified-live filtering), the behaviour is documented here
 * and mirrored there deliberately rather than by coincidence.
 */
export class InMemoryCatalogRepository implements CatalogRepository {
  readonly #agents = new Map<string, AgentRecord>();
  readonly #probes = new Map<string, ProbeResult[]>();
  readonly #checkpoints = new Map<ChainName, IndexerCheckpoint>();
  readonly #anchored: { at: Date; digest: Hex }[] = [];

  constructor(seed: readonly AgentRecord[] = []) {
    for (const r of seed) this.#agents.set(agentKey(r.id), r);
  }

  async upsertAgents(records: readonly AgentRecord[]): Promise<number> {
    for (const r of records) {
      const key = agentKey(r.id);
      const existing = this.#agents.get(key);
      // Never let a failed re-resolve erase a card we already have. A card
      // host being down today does not mean the agent stopped being real.
      this.#agents.set(
        key,
        existing?.card != null && r.card === null ? { ...r, card: existing.card } : r,
      );
    }
    return records.length;
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    return this.#agents.get(agentKey(id)) ?? null;
  }

  async recordProbe(result: ProbeResult): Promise<void> {
    const key = agentKey(result.agent);
    const list = this.#probes.get(key) ?? [];
    list.push(result);
    this.#probes.set(key, list);
  }

  async liveness(agent: AgentId): Promise<LivenessSummary> {
    return summarizeProbes(agent, this.#probes.get(agentKey(agent)) ?? []);
  }

  async dueForProbe(limit: number, staleAfterMs: number): Promise<readonly ProbeTarget[]> {
    const now = Date.now();
    const targets: ProbeTarget[] = [];

    for (const record of this.#agents.values()) {
      // No card means no declared endpoint to probe. Those agents are still
      // counted as registered; they simply cannot be proven live.
      for (const endpoint of record.card?.endpoints ?? []) {
        const history = this.#probes.get(agentKey(record.id)) ?? [];
        const forEndpoint = history.filter((p) => p.endpoint.url === endpoint.url);
        const lastProbedAt =
          forEndpoint.length === 0
            ? null
            : new Date(Math.max(...forEndpoint.map((p) => p.at.getTime())));
        if (lastProbedAt !== null && now - lastProbedAt.getTime() < staleAfterMs) continue;
        targets.push({ agent: record.id, endpoint, lastProbedAt });
      }
    }

    // Never-probed first, then least-recently-probed: a large catalog cycles
    // fairly instead of starving its tail.
    targets.sort((a, b) => (a.lastProbedAt?.getTime() ?? -1) - (b.lastProbedAt?.getTime() ?? -1));
    return targets.slice(0, limit);
  }

  async unanchoredProbes(limit: number): Promise<readonly ProbeResult[]> {
    const cutoff = this.#anchored.at(-1)?.at ?? null;
    return [...this.#probes.values()]
      .flat()
      .filter((p) => cutoff === null || p.at > cutoff)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
      .slice(0, limit);
  }

  async markProbesAnchored(upTo: Date, digest: Hex, _txHash: Hex): Promise<number> {
    const count = [...this.#probes.values()].flat().filter((p) => p.at <= upTo).length;
    this.#anchored.push({ at: upTo, digest });
    return count;
  }

  async lastAnchoredDigest(): Promise<Hex | null> {
    return this.#anchored.at(-1)?.digest ?? null;
  }

  async query(q: CatalogQuery): Promise<CatalogPage> {
    const now = new Date();
    const all: CatalogEntry[] = [];

    for (const record of this.#agents.values()) {
      if (q.chain !== undefined && record.id.chain !== q.chain) continue;
      if (q.category !== undefined && record.card?.category !== q.category) continue;
      const liveness = await this.liveness(record.id);
      const verifiedLive = isVerifiedLive(liveness, now);
      if (q.verifiedLiveOnly === true && !verifiedLive) continue;
      all.push({ record, liveness, verifiedLive });
    }

    all.sort((a, b) => Number(a.record.id.tokenId - b.record.id.tokenId));

    const offset = q.cursor === undefined ? 0 : Number.parseInt(q.cursor, 10);
    const limit = q.limit ?? 50;
    const entries = all.slice(offset, offset + limit);
    const nextOffset = offset + entries.length;

    return { entries, nextCursor: nextOffset < all.length ? String(nextOffset) : null };
  }

  async stats(chain: ChainName): Promise<CatalogStats> {
    const now = new Date();
    const records = [...this.#agents.values()].filter((r) => r.id.chain === chain);
    let verifiedLive = 0;
    for (const r of records) {
      if (isVerifiedLive(await this.liveness(r.id), now)) verifiedLive++;
    }
    return {
      chain,
      registered: records.length,
      withResolvableCard: records.filter((r) => r.card !== null).length,
      verifiedLive,
      computedAt: now,
    };
  }

  async checkpoint(chain: ChainName): Promise<IndexerCheckpoint | null> {
    return this.#checkpoints.get(chain) ?? null;
  }

  async setCheckpoint(chain: ChainName, lastBlock: bigint): Promise<void> {
    this.#checkpoints.set(chain, { chain, lastBlock, updatedAt: new Date() });
  }
}
