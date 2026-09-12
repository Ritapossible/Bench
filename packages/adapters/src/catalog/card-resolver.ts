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

    return normalizeCard(parsed as Record<string, unknown>, this.opts);
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
/**
 * The registration's logo, if it is one a browser can be asked to load.
 *
 * ERC-8004 registrations carry an `image`, and most of the maintained ones use
 * it - a competing marketplace renders these on every card while Bench's
 * catalog was text-only. It is worth having, and it is worth being careful
 * with, because the value is a URL a stranger chose and Bench renders it in a
 * visitor's browser.
 *
 * So the scheme is allowlisted rather than sanitised: https, ipfs and arweave
 * (both rewritten to a gateway), and data:image. `javascript:` and friends do
 * nothing in an `<img src>` on a current browser, but nothing is the wrong
 * thing to rely on when the input is this hostile - this registry contains
 * cards whose name field is a shell command. http:// is dropped too: the page
 * is served over TLS and a mixed-content image is blocked anyway, so keeping
 * it would only produce a broken image with a console warning.
 */
export function safeImageUrl(value: unknown, opts: CardResolverOptions = {}): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '' || raw.length > 2_048) return null;
  if (raw.startsWith('data:image/')) return raw;
  if (raw.startsWith('ipfs://') || raw.startsWith('ar://')) return toFetchableUrl(raw, opts);
  try {
    return new URL(raw).protocol === 'https:' ? raw : null;
  } catch {
    return null;
  }
}

export function normalizeCard(
  obj: Record<string, unknown>,
  opts: CardResolverOptions = {},
): AgentCard {
  const name = str(obj['name']) ?? str(obj['agentName']) ?? str(obj['title']);
  if (name === null) {
    throw new BenchError('INVALID_AGENT_CARD', 'card has no name');
  }

  const description = str(obj['description']) ?? str(obj['summary']) ?? str(obj['bio']) ?? '';

  const endpoints = extractEndpoints(obj);
  const category = inferCategory(obj, name, description);

  const card: AgentCard = {
    name,
    description,
    category,
    endpoints,
    // Spread: exactOptionalPropertyTypes forbids assigning undefined, and most
    // registrations publish no usable image.
    ...(() => {
      const image = safeImageUrl(obj['image'] ?? obj['logo'] ?? obj['avatar'], opts);
      return image === null ? {} : { image };
    })(),
    permissions: extractPermissions(obj),
    ...attestationOf(obj),
    raw: obj,
  };
  return card;
}

/** `exactOptionalPropertyTypes` forbids assigning undefined, hence the spread. */
function attestationOf(obj: Record<string, unknown>): {
  attestation?: { kind: string; ref: string };
} {
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
 *
 * Shapes here are not guesses. Surveyed against the 811 on-chain cards in the
 * ERC-8004 registry on BSC testnet (0x8004a8…bd9e): `services` carries them on
 * 581 cards and `endpoints` on 32, and the protocol sits in `name` far more
 * often than in `protocol` or `type` - a card reads
 * `{"name":"a2a","endpoint":"https://…"}`. Missing `name` was why every real
 * card parsed to zero endpoints, which would have made the whole catalog
 * unprobeable and every agent unverifiable.
 *
 * Names outside a2a/mcp/oasf are dropped on purpose. That survey also found
 * `web`, `x402`, `erc-8183`, `ens` and `email` endpoints, and none of them is
 * an agent-interaction protocol the prober can conformance-check. Admitting
 * them would inflate "verified live" with endpoints nothing ever verified,
 * which is the one number this project cannot afford to overstate.
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
      const protocol = asProtocol(rec['protocol'] ?? rec['name'] ?? rec['type'] ?? rec['kind']);
      if (protocol !== null)
        push(protocol, str(rec['url']) ?? str(rec['endpoint']) ?? str(rec['uri']));
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
/**
 * Declared categories, normalised.
 *
 * Real cards write the same category five ways. Matching the union members
 * exactly found two of the eight cards that declare one, and - because
 * `rebalancing` was not even in the list it matched against - a card declaring
 * `"category": "rebalancing"` fell through to the keyword pass, where
 * `rebalanc` sat inside the yield branch. The result was that `rebalancing`
 * could not be produced at all: 0 of 857 real cards, for one of the four
 * categories the main track scores diversity on.
 *
 * Keys are lowercased and stripped of separators before lookup, so
 * `Health-Factor Monitoring`, `health_factor_monitoring` and
 * `healthfactormonitoring` all land together.
 */
const DECLARED_ALIASES: Readonly<Record<string, AgentCategory>> = {
  rebalancing: 'rebalancing',
  rebalance: 'rebalancing',
  rebalancer: 'rebalancing',
  lprebalancing: 'rebalancing',
  portfoliorebalancing: 'rebalancing',
  rangemanagement: 'rebalancing',

  grid: 'grid',
  gridtrading: 'grid',
  gridbot: 'grid',

  yield: 'yield',
  yieldoptimisation: 'yield',
  yieldoptimization: 'yield',
  yieldfarming: 'yield',
  yieldaggregation: 'yield',

  healthfactor: 'health-factor',
  healthfactormonitoring: 'health-factor',
  liquidationprotection: 'health-factor',
  liquidation: 'health-factor',

  monitoring: 'monitoring',
  monitor: 'monitoring',
  alerts: 'monitoring',

  other: 'other',
};

/**
 * Keyword rules, most specific first.
 *
 * Order encodes specificity, not preference: a health-factor agent also talks
 * about lending yield, and an agent that resets an LP range also talks about
 * liquidity - so the narrower reading has to win. `rebalanc` moved out of the
 * yield branch for exactly that reason. Deliberately *not* widened to catch
 * more cards: 670 of 857 real cards are named things like `studio-agent`,
 * `rune-tutorial-agent` and `My Testnet Agent`, and they belong in `other`.
 * Forcing them into judged categories would inflate the diversity numbers with
 * test agents, which is the opposite of what this catalog is for.
 */
const KEYWORD_RULES: readonly (readonly [RegExp, AgentCategory])[] = [
  [/liquidat|health.?factor|collateral.?rati|\bltv\b|borrow.?risk|margin.?call/, 'health-factor'],
  [
    /rebalanc|allocation.?drift|turnover.?limit|range.?reset|drift.?threshold|portfolio.?weight/,
    'rebalancing',
  ],
  [/\bgrid\b|market.?mak|arbitrage|trading.?bot|\bdca\b|scalp|swing/, 'grid'],
  // Monitoring stays ahead of yield, where it has always been. Moving it below
  // would reclassify fourteen cards whose text matches both - an agent that
  // "monitors on-chain signals and executes token launches" reads no more like
  // yield than like monitoring - and every one of those moves would happen to
  // land in a category the contest scores diversity on. A tie broken toward
  // the judged bucket is not a classification, it is a thumb on the scale.
  [/monitor|alert|watch|notif|anomaly/, 'monitoring'],
  [/yield|\bapy\b|\bapr\b|farm|vault|stake|auto.?compound|\blp\b|liquidity/, 'yield'],
];

/**
 * Signal an agent card actually carries, flattened into one string.
 *
 * `capabilities` is read because real cards use it and this function did not:
 * 48 of 857 carry one, including entries like `allocation_drift`,
 * `turnover_limit`, `rebalance_proposal`, `yield-farming` and `auto-compound`,
 * which name the category more precisely than any prose does. It appears both
 * as an array of strings and as an object with `skills` / `domains`, so both
 * shapes are flattened. `skills` is read too, though no card in the registry
 * currently uses it.
 */
function categorySignal(obj: Record<string, unknown>): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) push(x);
    else if (typeof v === 'object' && v !== null) {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out.push(k);
        push(val);
      }
    }
  };
  push(obj['capabilities']);
  push(obj['skills']);
  return out;
}

export function inferCategory(
  obj: Record<string, unknown>,
  name: string,
  description: string,
): AgentCategory {
  const declared = str(obj['category'])
    ?.toLowerCase()
    .replace(/[^a-z]/g, '');
  if (declared !== undefined && declared !== '') {
    const alias = DECLARED_ALIASES[declared];
    // A declared category is the agent's own claim about itself and beats any
    // inference from prose. Unrecognised ones fall through rather than
    // becoming `other`, so a card saying "category: defi-lp-manager" is still
    // read by keyword instead of being silently discarded.
    if (alias !== undefined) return alias;
  }

  const haystack = [name, description, ...categorySignal(obj)].join(' ').toLowerCase();
  for (const [pattern, category] of KEYWORD_RULES) {
    if (pattern.test(haystack)) return category;
  }
  return 'other';
}
