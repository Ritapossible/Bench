import {
  BenchError,
  type AgentCard,
  type AgentId,
  type AgentRecord,
  type Hex,
  type ListAgentsQuery,
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

  constructor(
    private readonly agents: AgentRecord[] = [],
    private readonly cards: Map<string, AgentCard> = new Map(),
  ) {}

  async listAgents(q?: ListAgentsQuery): Promise<readonly AgentRecord[]> {
    return this.agents.slice(0, q?.limit ?? this.agents.length);
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    return (
      this.agents.find((a) => a.id.tokenId === id.tokenId && a.id.chain === id.chain) ?? null
    );
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
