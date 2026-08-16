import type { Address, ChainName, TokenAmount } from './primitives.js';

/**
 * Categories Bench scores. Each has its own scoring primitive — see
 * ARCHITECTURE.md section 5. `other` agents are listed and probed but ranked
 * only on liveness, never given a fabricated performance number.
 */
export type AgentCategory = 'yield' | 'grid' | 'monitoring' | 'health-factor' | 'other';

export type EndpointProtocol = 'a2a' | 'mcp' | 'oasf';

export interface AgentEndpoint {
  readonly protocol: EndpointProtocol;
  readonly url: string;
}

/**
 * Permissions the agent *declares* it needs. Declared, not verified — this
 * feeds the pre-hire safety label and the session-key allowlist we mint at
 * checkout. Treat as a claim by the agent, not a fact about it.
 */
export interface DeclaredPermissions {
  readonly contractAllowlist: readonly Address[];
  readonly maxSpendPerJob?: TokenAmount;
  readonly requiresTokenApprovals: boolean;
}

/** Resolved contents of the ERC-8004 Identity NFT's tokenURI. */
export interface AgentCard {
  readonly name: string;
  readonly description: string;
  readonly category: AgentCategory;
  readonly endpoints: readonly AgentEndpoint[];
  readonly permissions: DeclaredPermissions;
  /** TEE attestation reference, if the agent publishes one. */
  readonly attestation?: { readonly kind: string; readonly ref: string };
  readonly raw: unknown;
}

/** Stable identity of an agent: ERC-8004 Identity NFT on a specific chain. */
export interface AgentId {
  readonly chain: ChainName;
  readonly tokenId: bigint;
}

export interface AgentRecord {
  readonly id: AgentId;
  readonly owner: Address;
  readonly cardUri: string;
  /** Null when the tokenURI is unresolvable — common, and worth surfacing. */
  readonly card: AgentCard | null;
  readonly registeredAt: Date;
}

/**
 * One liveness probe. Powers the "verified live" filter, which is the cheapest
 * available fix for the ~96%-dead-agent problem on BSC.
 */
export interface ProbeResult {
  readonly agent: AgentId;
  readonly endpoint: AgentEndpoint;
  readonly at: Date;
  readonly reachable: boolean;
  readonly latencyMs: number | null;
  /** Did it actually speak the protocol it claims, or merely respond? */
  readonly conformant: boolean;
  readonly error?: string;
}
