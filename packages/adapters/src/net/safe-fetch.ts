import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { BenchError } from '@bench/core';

/**
 * ============================================================================
 * Outbound fetch for attacker-controlled URLs.
 * ============================================================================
 *
 * Every URL Bench fetches in Phase 1 — an agent card's tokenURI, a declared
 * A2A/MCP endpoint — is a string written by whoever registered the agent, and
 * registration on BSC testnet is gas-free. Fetching those with bare `fetch`
 * from a worker that also holds a Postgres connection and RPC credentials is a
 * server-side request forgery hole: `http://169.254.169.254/` reads cloud
 * instance metadata, `http://localhost:5432/` probes our own database.
 *
 * So this module, not `fetch`, is what the card resolver and the prober use.
 * Three separate limits, because they fail in three different ways:
 *
 *   - address filtering  → stops the request reaching internal infrastructure
 *   - timeout            → stops a slow endpoint pinning a worker
 *   - byte cap           → stops a hostile endpoint streaming until we OOM
 *
 * Known limitation, recorded rather than hidden: the DNS check and the socket
 * connect are separate steps, so a name that resolves differently between them
 * (DNS rebinding) can slip past. Closing that needs a pinned-IP connect hook
 * in the HTTP agent. Acceptable for the hackathon build against a public
 * catalog; not acceptable if Bench later fetches on behalf of a logged-in
 * user, and that is the trigger to fix it.
 */

export interface SafeFetchOptions {
  /** Budget for the HTTP exchange itself. Does not include name resolution. */
  readonly timeoutMs?: number;
  /**
   * Budget for name resolution, kept separate from `timeoutMs` on purpose.
   *
   * Folding DNS into the request budget made every slow lookup report itself
   * as `timeout after 5000ms`, which reads as "the endpoint is slow" and sent
   * a deployment hunting a network fault that did not exist. Measured on a
   * quiet machine at the prober's concurrency, `dns.lookup` runs p50 395ms and
   * p99 2426ms - so on a busy host a lookup alone could spend the entire
   * request budget before a packet left, and the message would blame the
   * endpoint for it.
   */
  readonly dnsTimeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
  /** Tests point at 127.0.0.1. Never enable in the worker. */
  readonly allowLoopback?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET' | 'POST';
  readonly body?: string;
}

const DEFAULTS = {
  timeoutMs: 5_000,
  dnsTimeoutMs: 3_000,
  maxBytes: 512 * 1024,
  maxRedirects: 3,
} as const;

/**
 * Resolutions are cached briefly, because a single A2A probe resolves the same
 * host three times - two well-known card paths and the declared endpoint - and
 * `dns.lookup` is bound by the libuv threadpool, which is four threads by
 * default. Two hundred agents a tick therefore queued six hundred lookups
 * behind four threads, and the queue, not any endpoint, is what exhausted the
 * timeout.
 *
 * The TTL is deliberately short. This cache decides whether an address is
 * allowed, so holding a resolution for long enough to matter would widen the
 * DNS-rebinding window already recorded above.
 */
const DNS_TTL_MS = 60_000;
const DNS_CACHE_MAX = 4_096;
const dnsCache = new Map<
  string,
  { readonly addresses: readonly string[]; readonly expires: number }
>();

async function resolveCached(host: string, timeoutMs: number): Promise<readonly string[]> {
  const now = Date.now();
  const hit = dnsCache.get(host);
  if (hit !== undefined && hit.expires > now) return hit.addresses;

  let timer: NodeJS.Timeout | undefined;
  try {
    const resolved = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new BenchError(
                'ENDPOINT_UNREACHABLE',
                `DNS lookup timed out after ${timeoutMs}ms for ${host}`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
    const addresses = resolved.map((r) => r.address);
    // Bounded, and oldest-first: Map preserves insertion order, so deleting
    // the first key evicts the least recently added rather than at random.
    if (dnsCache.size >= DNS_CACHE_MAX) {
      const oldest = dnsCache.keys().next();
      if (!oldest.done) dnsCache.delete(oldest.value);
    }
    dnsCache.set(host, { addresses, expires: now + DNS_TTL_MS });
    return addresses;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam: the cache is process-wide and would leak between test cases. */
export function clearDnsCache(): void {
  dnsCache.clear();
}

/** Test seam: how many hosts are currently cached. */
export function dnsCacheSize(): number {
  return dnsCache.size;
}

export interface SafeResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: string;
  readonly truncated: boolean;
  readonly latencyMs: number;
  readonly finalUrl: string;
}

/** Reserved IPv4 ranges as [firstOctetMatch, predicate] over the four octets. */
function isBlockedIPv4(ip: string, allowLoopback: boolean): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable is blocked, not allowed
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 127) return !allowLoopback; // loopback
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local — cloud metadata lives here
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Expand an IPv6 address to its eight hextets, or null if it will not parse.
 *
 * Needed because the textual form cannot be pattern-matched safely. WHATWG
 * URL parsing rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]` and
 * `[0:0:0:0:0:ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, so a regex over
 * the dotted-quad form never fires for anything that arrived as a URL — which
 * is every host this module sees. Matching on structure instead of on spelling
 * is the only way this stays correct across those rewrites.
 */
function expandIPv6(addr: string): number[] | null {
  const [headRaw, tailRaw, ...rest] = addr.split('::');
  if (rest.length > 0) return null; // '::' may appear at most once

  const toHextets = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        // Trailing dotted-quad form: a.b.c.d occupies the last two hextets.
        const octets = piece.split('.').map(Number);
        if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
          return null;
        const [a, b, c, d] = octets as [number, number, number, number];
        out.push((a << 8) | b, (c << 8) | d);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      out.push(Number.parseInt(piece, 16));
    }
    return out;
  };

  const head = toHextets(headRaw ?? '');
  const tail = tailRaw === undefined ? [] : toHextets(tailRaw);
  if (head === null || tail === null) return null;

  if (tailRaw === undefined) return head.length === 8 ? head : null;

  const gap = 8 - head.length - tail.length;
  if (gap < 0) return null;
  return [...head, ...new Array<number>(gap).fill(0), ...tail];
}

function isBlockedIPv6(ip: string, allowLoopback: boolean): boolean {
  const addr = ip.toLowerCase().split('%')[0] ?? '';

  const h = expandIPv6(addr);
  if (h === null) return true; // unparseable is blocked, not allowed

  // An IPv4 destination wearing a v6 hat. Both the mapped form (::ffff:a.b.c.d)
  // and the deprecated compatible form (::a.b.c.d) reach the same host, so both
  // are decided by the IPv4 rules rather than the IPv6 ones.
  const leadingZero = h.slice(0, 5).every((x) => x === 0);
  const isMapped = leadingZero && h[5] === 0xffff;
  const isCompatible =
    leadingZero && h[5] === 0 && (h[6] !== 0 || h[7] !== 0) && !(h[6] === 0 && h[7] === 1);
  if (isMapped || isCompatible) {
    const hi = h[6]!;
    const lo = h[7]!;
    const dotted = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isBlockedIPv4(dotted, allowLoopback);
  }

  if (addr === '::1') return !allowLoopback;
  if (addr === '::') return true;
  if (/^f[cd]/.test(addr)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return true; // fe80::/10 link-local
  if (/^ff/.test(addr)) return true; // multicast
  return false;
}

const isBlockedAddress = (ip: string, allowLoopback: boolean): boolean =>
  isIP(ip) === 6 ? isBlockedIPv6(ip, allowLoopback) : isBlockedIPv4(ip, allowLoopback);

/**
 * Reject a URL before any packet leaves. Exported because the prober wants to
 * label an agent's endpoint as unreachable-by-policy without paying for a
 * request, and the catalog wants to explain *why* an endpoint was refused.
 */
export async function assertPublicUrl(
  raw: string,
  allowLoopback = false,
  dnsTimeoutMs: number = DEFAULTS.dnsTimeoutMs,
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BenchError('ENDPOINT_UNREACHABLE', `malformed URL: ${raw}`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // file:, gopher:, and friends are how SSRF filters get bypassed.
    throw new BenchError('ENDPOINT_UNREACHABLE', `blocked scheme ${url.protocol} in ${raw}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, '');

  if (isIP(host) !== 0) {
    if (isBlockedAddress(host, allowLoopback)) {
      throw new BenchError('ENDPOINT_UNREACHABLE', `blocked address ${host}`);
    }
    return url;
  }

  let resolved: readonly string[];
  try {
    resolved = await resolveCached(host, dnsTimeoutMs);
  } catch (err) {
    // A timeout already says what happened and to whom; only a genuine
    // resolution failure needs the generic message.
    if (err instanceof BenchError) throw err;
    throw new BenchError('ENDPOINT_UNREACHABLE', `DNS lookup failed for ${host}`);
  }
  if (resolved.length === 0) {
    throw new BenchError('ENDPOINT_UNREACHABLE', `no addresses for ${host}`);
  }
  // Every resolved address must be public: one internal A record is enough to
  // make the request dangerous, since we do not control which one is dialled.
  for (const address of resolved) {
    if (isBlockedAddress(address, allowLoopback)) {
      throw new BenchError('ENDPOINT_UNREACHABLE', `${host} resolves to blocked ${address}`);
    }
  }
  return url;
}

/**
 * Fetch with the three limits applied. Redirects are followed manually so that
 * every hop is re-validated — `redirect: 'follow'` would let a public URL
 * bounce us to 169.254.169.254 with no second check.
 */
export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions = {},
): Promise<SafeResponse> {
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  const dnsTimeoutMs = opts.dnsTimeoutMs ?? DEFAULTS.dnsTimeoutMs;
  const maxBytes = opts.maxBytes ?? DEFAULTS.maxBytes;
  const maxRedirects = opts.maxRedirects ?? DEFAULTS.maxRedirects;
  const allowLoopback = opts.allowLoopback ?? false;

  const started = Date.now();
  // Time spent resolving names, summed across hops and excluded from the
  // request budget. Reported in the timeout message so a slow resolver is
  // visible as a slow resolver rather than as a slow endpoint.
  let dnsMs = 0;
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const dnsStarted = Date.now();
    const url = await assertPublicUrl(current, allowLoopback, dnsTimeoutMs);
    dnsMs += Date.now() - dnsStarted;

    const controller = new AbortController();
    // The budget is for the whole call, not per hop, so a redirect chain
    // cannot multiply the time a single probe is allowed to take.
    const remaining = timeoutMs - (Date.now() - started - dnsMs);
    if (remaining <= 0) {
      throw new BenchError(
        'ENDPOINT_UNREACHABLE',
        `request timed out after ${timeoutMs}ms (dns ${dnsMs}ms): ${rawUrl}`,
      );
    }
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': 'Bench/0.1 (+https://github.com/Ritapossible/Bench)',
          ...opts.headers,
        },
        ...(opts.body === undefined ? {} : { body: opts.body }),
      });

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (location === null) {
          throw new BenchError('ENDPOINT_UNREACHABLE', `${res.status} with no Location`);
        }
        current = new URL(location, url).toString();
        continue;
      }

      const { body, truncated } = await readCapped(res, maxBytes);
      return {
        status: res.status,
        headers: res.headers,
        body,
        truncated,
        latencyMs: Date.now() - started,
        finalUrl: url.toString(),
      };
    } catch (err) {
      if (err instanceof BenchError) throw err;
      const reason =
        err instanceof Error && err.name === 'AbortError'
          ? `request timed out after ${timeoutMs}ms (dns ${dnsMs}ms)`
          : String(err);
      throw new BenchError('ENDPOINT_UNREACHABLE', `${rawUrl}: ${reason}`, err);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new BenchError('ENDPOINT_UNREACHABLE', `too many redirects (>${maxRedirects}): ${rawUrl}`);
}

/**
 * Read at most `maxBytes`, then stop pulling. Content-Length is checked first
 * as a cheap rejection, but it is only a hint — a hostile server can lie or
 * omit it, so the streaming cap is the real limit.
 */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ body: string; truncated: boolean }> {
  const declared = Number(res.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    void res.body?.cancel();
    return { body: '', truncated: true };
  }

  if (res.body === null) return { body: '', truncated: false };

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { body: Buffer.concat(chunks).toString('utf8'), truncated };
}
