import type { Address, ChainName, TokenAmount } from './primitives.js';

/**
 * Categories Bench scores. Each has its own scoring primitive — see
 * ARCHITECTURE.md section 5.
 *
 * The first four are **the four the main track judges on**: the contest
 * requires the marketplace to surface rebalancing, grid trading, yield
 * optimization and health-factor monitoring *with equal depth*, and Agent
 * Diversity is one of only three stated criteria. They are listed first here
 * because that order is the order the catalog presents them in.
 *
 * `monitoring` and `other` are extras: listed and probed, ranked on liveness,
 * never given a fabricated performance number.
 */
export type AgentCategory =
  | 'rebalancing'
  | 'grid'
  | 'yield'
  | 'health-factor'
  | 'monitoring'
  | 'other';

/** Every category, in presentation order. One list, so no caller invents its own. */
export const AGENT_CATEGORIES = [
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
  'monitoring',
  'other',
] as const satisfies readonly AgentCategory[];

/** The four the main track scores on Agent Diversity. Order is presentation order. */
export const JUDGED_CATEGORIES = [
  'rebalancing',
  'grid',
  'yield',
  'health-factor',
] as const satisfies readonly AgentCategory[];

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
  /**
   * A logo the registration published, if it published one this page can load.
   *
   * Untrusted: the URL comes from a stranger's registration and is rendered in
   * a visitor's browser, so only https and data:image survive parsing. See
   * `safeImageUrl`.
   */
  readonly image?: string;
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
  /**
   * Why the card did not resolve, when it didn't. The failure reasons are the
   * evidence behind the catalog-density figure Bench publishes, so they are
   * stored rather than logged and discarded: "96% are dead" is only a credible
   * claim if we can say how each one was dead.
   */
  readonly cardError?: string;
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
