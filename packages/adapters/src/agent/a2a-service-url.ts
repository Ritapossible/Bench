import { safeFetch } from '../net/safe-fetch.js';

/**
 * ============================================================================
 * The registered A2A endpoint is the agent card. The service is inside it.
 * ============================================================================
 *
 * ERC-8004 registrations on BSC point their A2A service at the well-known card
 * path, not at the JSON-RPC endpoint:
 *
 *   {"services":[{"name":"A2A",
 *     "endpoint":"https://proofera-lp.tangvu.dev/.well-known/agent-card.json"}]}
 *
 * and the card that lives there carries the actual service address in its own
 * `url` field ("https://proofera-lp.tangvu.dev/"). Bench drove the registered
 * URL directly, so every audition POSTed `message/send` at a static JSON file.
 * A file server answers GET and refuses POST, which is exactly what the
 * catalog recorded: `agent returned HTTP 404 to the audition task` on 1691 and
 * 1825, `HTTP 405` on 1597. Every one of those was read as the agent being
 * dead. ProofEra, the agent behind one of the 404s, answers `message/send` on
 * its real URL and returns -32601 for a method it does not know - it was alive
 * the entire time, and Bench was knocking on the wrong door and then
 * publishing that the house was empty.
 *
 * The hop is only taken for card-shaped URLs. A registration that already
 * names a service endpoint is left alone rather than paying a GET to discover
 * it does not need one.
 */

/** Card-shaped: a well-known path, or anything ending in `.json`. */
export function looksLikeAgentCard(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  return path.startsWith('/.well-known/') || path.endsWith('.json');
}

/**
 * The service address a card declares, or null if it declares none usable.
 *
 * Relative URLs resolve against the card's own location, which is what the A2A
 * spec means by a card being self-describing. A card whose `url` is not
 * http(s) is refused here rather than handed to fetch: `preferredTransport`
 * can name GRPC, and a grpc:// address that reached the shim would fail as a
 * network error and read as an unreachable agent rather than as one this
 * driver cannot speak to.
 */
export function serviceUrlFromCard(body: string, cardUrl: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const card = parsed as Record<string, unknown>;

  const candidates: unknown[] = [card['url']];
  // `additionalInterfaces` is where a multi-transport card puts its JSONRPC
  // address when `url` names something else.
  const extra = card['additionalInterfaces'];
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      if (typeof entry !== 'object' || entry === null) continue;
      const rec = entry as Record<string, unknown>;
      const transport = typeof rec['transport'] === 'string' ? rec['transport'].toUpperCase() : '';
      if (transport === 'JSONRPC') candidates.unshift(rec['url']);
    }
  }

  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue;
    let resolved: URL;
    try {
      resolved = new URL(candidate, cardUrl);
    } catch {
      continue;
    }
    if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.toString();
  }
  return null;
}

/**
 * Follow a card-shaped A2A endpoint to the service it names.
 *
 * Falls back to the registered URL on every failure. A card that will not
 * parse is a fact worth recording, but it is not this function's to report:
 * the caller then drives the registered URL and records whatever that
 * actually answers, which is a measurement rather than an inference.
 */
export interface ResolvedA2AService {
  /** Where to POST. The card's `url`, or the registered endpoint unchanged. */
  readonly url: string;
  /**
   * The card itself, when one was read.
   *
   * Kept rather than discarded because the card is also how an agent says what
   * it will accept - its skills and its input modes decide the shape of the
   * request, and fetching it twice to learn that would be a second round trip
   * for something already in hand.
   */
  readonly card: Record<string, unknown> | null;
}

export async function resolveA2AService(
  endpointUrl: string,
  opts: {
    readonly timeoutMs?: number;
    readonly dnsTimeoutMs?: number;
    readonly allowLoopback?: boolean;
    readonly fetchImpl?: typeof safeFetch;
  } = {},
): Promise<ResolvedA2AService> {
  if (!looksLikeAgentCard(endpointUrl)) return { url: endpointUrl, card: null };

  const fetchOne = opts.fetchImpl ?? safeFetch;
  try {
    const res = await fetchOne(endpointUrl, {
      method: 'GET',
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(opts.dnsTimeoutMs === undefined ? {} : { dnsTimeoutMs: opts.dnsTimeoutMs }),
      ...(opts.allowLoopback === true ? { allowLoopback: true } : {}),
      headers: { accept: 'application/json' },
    });
    if (res.status < 200 || res.status >= 300) return { url: endpointUrl, card: null };

    let card: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(res.body);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        card = parsed as Record<string, unknown>;
      }
    } catch {
      card = null;
    }
    return { url: serviceUrlFromCard(res.body, endpointUrl) ?? endpointUrl, card };
  } catch {
    return { url: endpointUrl, card: null };
  }
}

/** The address alone, for callers that do not need the card. */
export async function resolveA2AServiceUrl(
  endpointUrl: string,
  opts: Parameters<typeof resolveA2AService>[1] = {},
): Promise<string> {
  return (await resolveA2AService(endpointUrl, opts)).url;
}
