import {
  BenchError,
  type AgentCard,
  type AgentCategory,
  type AgentEndpoint,
  type DeclaredPermissions,
  type EndpointProtocol,
  type Address,
} from '@bench/core';
import { safeFetch, type SafeFetchOptions } from '../net/safe-fetch.js';

/**
 * Resolves an ERC-8004 Identity NFT `tokenURI` to an agent card.
 *
 * The governing fact: **most cards do not resolve**, and that is the normal
 * path, not the error path. Only ~4% of BSC registrations have a resolvable
 * card with a live endpoint. So this module is written to be relentlessly
 * defensive and to fail with a *reason* — the reasons are the dataset behind
 * the catalog-density number Bench publishes, so "it didn't work" is not a
 * good enough answer.
 *
 * Cards are also attacker-controlled: registration is gas-free on BSC testnet,
 * so anyone can point a tokenURI anywhere. Fetching goes through safeFetch
 * (SSRF filtering, timeout, byte cap), and every field is treated as hostile
 * input to be validated rather than data to be trusted.
 */

export interface CardResolverOptions extends SafeFetchOptions {
  /** Gateway for ipfs:// URIs. Most agent cards on BSC are IPFS-hosted. */
  readonly ipfsGateway?: string;
  readonly arweaveGateway?: string;
}

const DEFAULT_IPFS_GATEWAY = 'https://ipfs.io/ipfs/';
const DEFAULT_ARWEAVE_GATEWAY = 'https://arweave.net/';

/**
 * Rewrite a content-addressed URI to something fetchable. Kept separate from
 * fetching so it is testable without a network and so the gateway choice is
 * one line to change when a gateway starts rate-limiting us mid-backfill.
 */
export function toFetchableUrl(uri: string, opts: CardResolverOptions = {}): string {
  const ipfsGateway = opts.ipfsGateway ?? DEFAULT_IPFS_GATEWAY;
  const arweaveGateway = opts.arweaveGateway ?? DEFAULT_ARWEAVE_GATEWAY;

  if (uri.startsWith('ipfs://')) {
    // Both ipfs://<cid> and the redundant ipfs://ipfs/<cid> appear in the wild.
    const path = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
    return `${ipfsGateway}${path}`;
  }
  if (uri.startsWith('ar://')) return `${arweaveGateway}${uri.slice('ar://'.length)}`;
  return uri;
}

/** data: URIs are inlined on-chain and need no network at all. */
function readDataUri(uri: string): string {
  const comma = uri.indexOf(',');
  if (comma === -1) throw new BenchError('INVALID_AGENT_CARD', 'malformed data: URI');
  const meta = uri.slice('data:'.length, comma);
  const payload = uri.slice(comma + 1);
  return meta.includes(';base64')
    ? Buffer.from(payload, 'base64').toString('utf8')
    : decodeURIComponent(payload);
}

export class CardResolver {
  constructor(private readonly opts: CardResolverOptions = {}) {}

  /**
   * Throws BenchError('INVALID_AGENT_CARD') with a specific message on every
   * failure path. Callers store the reason and carry on with `card: null` —
   * they must never drop the agent, because an agent with an unresolvable card
   * is still a registered agent and still counts in the denominator.
   */
  async resolve(uri: string): Promise<AgentCard> {
    const text = await this.fetchRaw(uri);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new BenchError('INVALID_AGENT_CARD', `not JSON: ${uri}`);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BenchError('INVALID_AGENT_CARD', `not a JSON object: ${uri}`);
    }

    return normalizeCard(parsed as Record<string, unknown>);
  }

  private async fetchRaw(uri: string): Promise<string> {
    if (uri.startsWith('data:')) return readDataUri(uri);

    const url = toFetchableUrl(uri, this.opts);
    const res = await safeFetch(url, this.opts);
    if (res.status < 200 || res.status >= 300) {
      throw new BenchError('INVALID_AGENT_CARD', `HTTP ${res.status} for ${uri}`);
    }
    if (res.truncated) {
      // A card over the byte cap is not a card; it is someone testing us.
      throw new BenchError('INVALID_AGENT_CARD', `card exceeds size cap: ${uri}`);
    }
    return res.body;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/**
 * Pull an AgentCard out of an untrusted object.
 *
 * Real cards vary: some follow the A2A agent-card shape, some are ERC-8004
 * registration blobs, some are neither. Rather than demand one schema and
 * discard ~everything, accept the union of the shapes seen in practice and
 * record the original under `raw` so a later parser improvement can re-mine
 * cards already indexed without re-fetching them.
 */
export function normalizeCard(obj: Record<string, unknown>): AgentCard {
  const name = str(obj['name']) ?? str(obj['agentName']) ?? str(obj['title']);
  if (name === null) {
    throw new BenchError('INVALID_AGENT_CARD', 'card has no name');
  }

  const description =
    str(obj['description']) ?? str(obj['summary']) ?? str(obj['bio']) ?? '';

  const endpoints = extractEndpoints(obj);
  const category = inferCategory(obj, name, description);

  const card: AgentCard = {
    name,
    description,
    category,
    endpoints,
    permissions: extractPermissions(obj),
    ...attestationOf(obj),
    raw: obj,
  };
  return card;
}

/** `exactOptionalPropertyTypes` forbids assigning undefined, hence the spread. */
function attestationOf(obj: Record<string, unknown>): { attestation?: { kind: string; ref: string } } {
  const a = obj['attestation'] ?? obj['tee'];
  if (typeof a !== 'object' || a === null) return {};
  const rec = a as Record<string, unknown>;
  const kind = str(rec['kind']) ?? str(rec['type']);
  const ref = str(rec['ref']) ?? str(rec['url']) ?? str(rec['quote']);
  return kind !== null && ref !== null ? { attestation: { kind, ref } } : {};
}

const PROTOCOLS: readonly EndpointProtocol[] = ['a2a', 'mcp', 'oasf'];

const asProtocol = (v: unknown): EndpointProtocol | null => {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  return PROTOCOLS.find((p) => s === p || s.startsWith(`${p}-`)) ?? null;
};

/**
 * Endpoints appear under at least four different keys across real cards. Order
 * matters only in that we de-duplicate by URL and keep the first protocol seen.
 */
function extractEndpoints(obj: Record<string, unknown>): readonly AgentEndpoint[] {
  const found: AgentEndpoint[] = [];
  const push = (protocol: EndpointProtocol, url: string | null): void => {
    if (url !== null && !found.some((e) => e.url === url)) found.push({ protocol, url });
  };

  // Shape 1: { endpoints: [{ protocol, url }] } or { endpoints: { a2a: url } }
  const eps = obj['endpoints'] ?? obj['services'] ?? obj['interfaces'];
  if (Array.isArray(eps)) {
    for (const raw of eps) {
      if (typeof raw !== 'object' || raw === null) continue;
      const rec = raw as Record<string, unknown>;
      const protocol = asProtocol(rec['protocol'] ?? rec['type'] ?? rec['kind']);
      if (protocol !== null) push(protocol, str(rec['url']) ?? str(rec['endpoint']) ?? str(rec['uri']));
    }
  } else if (typeof eps === 'object' && eps !== null) {
    for (const [key, value] of Object.entries(eps as Record<string, unknown>)) {
      const protocol = asProtocol(key);
      if (protocol !== null) push(protocol, str(value));
    }
  }

  // Shape 2: top-level A2A card — a bare `url` plus a capabilities object.
  const topUrl = str(obj['url']) ?? str(obj['serviceEndpoint']);
  if (topUrl !== null) {
    const declared = asProtocol(obj['protocol']);
    // A2A is the default guess only because a bare `url` on an agent card is
    // the A2A shape. The prober decides the truth; this is just where to knock.
    push(declared ?? 'a2a', topUrl);
  }

  return found;
}

/**
 * Permissions are a *claim by the agent*, never a fact about it. They feed the
 * pre-hire safety label and seed the session-key contract allowlist at
 * checkout, so parse them conservatively: an unparseable allowlist becomes
 * empty (deny-all), never absent (allow-all).
 */
function extractPermissions(obj: Record<string, unknown>): DeclaredPermissions {
  const p = obj['permissions'] ?? obj['declaredPermissions'] ?? {};
  const rec = typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {};

  const rawList = rec['contractAllowlist'] ?? rec['contracts'] ?? rec['allowlist'];
  const contractAllowlist = Array.isArray(rawList)
    ? rawList.filter((x): x is Address => typeof x === 'string' && /^0x[a-fA-F0-9]{40}$/.test(x))
    : [];

  return {
    contractAllowlist,
    requiresTokenApprovals: rec['requiresTokenApprovals'] === true || rec['approvals'] === true,
  };
}

/**
 * Category drives which scorer runs (ARCHITECTURE.md §5), so a wrong guess
 * produces a meaningless number rather than a missing one. An explicit
 * declaration always wins; keyword inference is a fallback, and anything
 * unrecognised becomes 'other' — listed and probed, but never handed a
 * fabricated performance score.
 */
export function inferCategory(
  obj: Record<string, unknown>,
  name: string,
  description: string,
): AgentCategory {
  const declared = str(obj['category'])?.toLowerCase();
  const CATEGORIES: readonly AgentCategory[] = ['yield', 'grid', 'monitoring', 'health-factor', 'other'];
  const exact = CATEGORIES.find((c) => c === declared);
  if (exact !== undefined) return exact;

  const skills = Array.isArray(obj['skills'])
    ? obj['skills']
        .map((s) => (typeof s === 'string' ? s : str((s as Record<string, unknown> | null)?.['name'])))
        .filter((s): s is string => s !== null)
    : [];
  const haystack = [name, description, ...skills].join(' ').toLowerCase();

  // Ordered most-specific first: "liquidation" implies health-factor even
  // though a health-factor agent also talks about lending yield.
  if (/liquidat|health factor|collateral ratio|ltv/.test(haystack)) return 'health-factor';
  if (/grid|market.?mak|arbitrage|trading bot|dca/.test(haystack)) return 'grid';
  if (/monitor|alert|watch|notif|anomaly/.test(haystack)) return 'monitoring';
  if (/yield|lp|liquidity|farm|vault|stake|rebalanc|apy/.test(haystack)) return 'yield';
  return 'other';
}
