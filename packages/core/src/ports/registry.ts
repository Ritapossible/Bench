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
export interface EnumerateOptions {
  /** First token id to read. Defaults to 0. */
  readonly fromTokenId?: bigint;
  /** Stop after this many, so one tick cannot run unbounded. */
  readonly limit?: number;
  /**
   * Consecutive missing ids tolerated before the walk concludes.
   *
   * A burned token leaves a hole, and stopping at the first one would truncate
   * the catalog at that hole and silently lose every agent above it. Reading a
   * short run past a gap costs a handful of calls and is the difference
   * between a complete catalog and a quietly incomplete one.
   */
  readonly gapTolerance?: number;
}

export interface EnumerationResult {
  readonly agents: readonly AgentRecord[];
  /** Highest id actually read, so the next walk resumes above it. */
  readonly lastTokenId: bigint;
  /** False when `limit` stopped the walk early rather than the registry ending. */
  readonly reachedEnd: boolean;
}

export interface RegistryClient {
  /**
   * Chain head. On the port because the indexer needs it to decide how far it
   * may safely read, and going around the port for it would mean the worker
   * holding its own RPC client — a second place for the chain config to drift.
   */
  headBlock(): Promise<bigint>;
  /**
   * The highest token id the registry has minted.
   *
   * Needed because the useful end of a large registry is the *recent* end. On
   * BSC mainnet the oldest 28,000 registrations declare a callable endpoint
   * 1.27% of the time against 11.40% registry-wide, so a catalog that fills
   * from zero spends its first half-day ingesting the deadest slice of the
   * registry while showing almost nothing live.
   *
   * There is no `totalSupply` on these contracts - it reverts - so this is
   * found by doubling past the end and bisecting back, about forty reads.
   */
  headTokenId(): Promise<bigint>;
  /**
   * Read an inclusive range of token ids, skipping the ones that do not exist.
   *
   * Unlike `enumerateAgents`, a gap does not end the read: walking downward
   * through a registry, holes are burned or never-minted ids in the middle of
   * it, and stopping at one would truncate the pass.
   */
  readTokenRange(fromTokenId: bigint, toTokenId: bigint): Promise<readonly AgentRecord[]>;
  listAgents(q?: ListAgentsQuery): Promise<readonly AgentRecord[]>;
  /**
   * Discover agents by walking token ids rather than registration logs.
   *
   * Log scanning is the obvious way to find registrations and it is the wrong
   * one for a backfill against a public node. Registration events sit in
   * history, and every free BSC endpoint prunes it - measured at eleven hours
   * on the best of them - so reconstructing months of registrations needs an
   * archive node nobody hands out for free.
   *
   * `ownerOf` and `tokenURI` are *current state*, not history, so a pruned node
   * answers them for a token minted in February exactly as well as for one
   * minted this morning. For a registry that mints sequentially, that turns
   * discovery into a walk from zero: read until `ownerOf` reverts, and the end
   * of the walk is the end of the registry.
   *
   * The chain remains the only source of truth here - this changes how agents
   * are *found*, not what is believed about them.
   *
   * Returns agents in token-id order. `fromTokenId` resumes a walk, which is
   * also how the tail works: new registrations take the next id, so probing
   * upward from the last known one costs a call or two when nothing has
   * happened.
   */
  enumerateAgents(opts?: EnumerateOptions): Promise<EnumerationResult>;
  getAgent(id: AgentId): Promise<AgentRecord | null>;
  /** Resolve an Identity NFT tokenURI to its card. Throws INVALID_AGENT_CARD. */
  resolveCard(uri: string): Promise<AgentCard>;
  watchRegistrations(
    fromBlock: bigint,
    onAgent: (a: AgentRecord) => Promise<void>,
  ): Promise<() => void>;
  writeValidation(entry: ValidationEntry): Promise<Hex>;
  /** Rolling probe-result hash, anchored so liveness is auditable not asserted. */
  anchorProbeDigest(digest: Hex): Promise<Hex>;
}
