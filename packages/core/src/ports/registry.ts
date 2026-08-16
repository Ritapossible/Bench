import type { AgentCard, AgentId, AgentRecord } from '../types/agent.js';
import type { OutcomeRecord } from '../types/audition.js';
import type { Hex } from '../types/primitives.js';

export interface ListAgentsQuery {
  readonly fromBlock?: bigint;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ValidationEntry {
  readonly agent: AgentId;
  readonly outcome: OutcomeRecord;
  /** Hash over {forkBlock, seed, window} so anyone can replay and verify. */
  readonly replayHash: Hex;
}

/**
 * ERC-8004 registry access.
 *
 * Note `writeValidation` targets the **Validation Registry**, not the
 * Reputation Registry. Validation carries verifiable semantics and validator
 * hooks; reputation carries unweighted attestations that the research shows
 * are trivially gamed. Bench's output belongs in the registry that can be
 * checked. There is deliberately no `writeReputation` on this port.
 */
export interface RegistryClient {
  listAgents(q?: ListAgentsQuery): Promise<readonly AgentRecord[]>;
  getAgent(id: AgentId): Promise<AgentRecord | null>;
  /** Resolve an Identity NFT tokenURI to its card. Throws INVALID_AGENT_CARD. */
  resolveCard(uri: string): Promise<AgentCard>;
  watchRegistrations(fromBlock: bigint, onAgent: (a: AgentRecord) => Promise<void>): Promise<() => void>;
  writeValidation(entry: ValidationEntry): Promise<Hex>;
  /** Rolling probe-result hash, anchored so liveness is auditable not asserted. */
  anchorProbeDigest(digest: Hex): Promise<Hex>;
}
