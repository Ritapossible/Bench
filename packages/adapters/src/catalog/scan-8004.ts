import {
  nullCrossReference,
  type AgentId,
  type CrossReferenceRecord,
  type CrossReferenceResult,
  type CrossReferenceSource,
} from '@bench/core';
import { safeFetch } from '../net/safe-fetch.js';

/**
 * AltLayer's 8004scan as a cross-reference — ARCHITECTURE.md 3.1.
 *
 * Bench indexes the registry from chain with viem; 8004scan is a *second
 * opinion*, never the source. Two things follow from that and shape this
 * whole file:
 *
 *   1. **It cannot gate the catalog.** Every failure path returns a status,
 *      not an exception. Unconfigured is the normal state until a key is
 *      granted, and it is not an error.
 *   2. **An unrecognised response is `unavailable`, not data.** Bench
 *      publishes an agreement figure from this; inventing corroboration from a
 *      shape we did not understand would be worse than publishing nothing.
 *
 * **The response schema below is unverified.** It was written without an API
 * key against the documented resource shape, so `parseAgentPayload` accepts
 * several plausible encodings and refuses everything else rather than guessing.
 * When a key arrives, run the integration check in the test file against the
 * real endpoint and tighten this to whatever it actually returns.
 */

export interface Scan8004Options {
  /** Absent → `buildCrossReference` returns a no-op source. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  /** Pro tier documents 500/min. Kept well under, since bursts are what trip limiters. */
  readonly requestsPerMinute?: number;
  readonly timeoutMs?: number;
  readonly concurrency?: number;
  /** Test seam. */
  readonly allowLoopback?: boolean;
}

const DEFAULTS = {
  baseUrl: 'https://8004scan.io/api/v1',
  requestsPerMinute: 300,
  timeoutMs: 6_000,
  concurrency: 4,
} as const;

/**
 * Spaces request *starts* by a fixed interval.
 *
 * A token bucket would allow a burst up to the bucket size, and a burst is
 * exactly what gets an API key rate-limited on the first run over a few
 * hundred agents. Even spacing is slower and survives.
 */
class Pacer {
  #next = 0;
  constructor(private readonly intervalMs: number) {}

  async wait(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.#next);
    this.#next = at + this.intervalMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
}

/** Narrow an unknown JSON body to the facts we are willing to publish. */
export function parseAgentPayload(body: unknown): { known: boolean; endpointCount: number | null } | null {
  if (body === null || typeof body !== 'object') return null;
  const o = body as Record<string, unknown>;

  // Some APIs wrap the resource, some return it bare.
  const inner = (o['data'] ?? o['agent'] ?? o['result'] ?? o) as Record<string, unknown>;
  if (inner === null || typeof inner !== 'object') return null;

  // An explicit not-found is a *successful* comparison, not a failure.
  if (o['error'] === 'not_found' || o['found'] === false) return { known: false, endpointCount: null };

  const hasIdentity =
    typeof inner['tokenId'] === 'string' ||
    typeof inner['tokenId'] === 'number' ||
    typeof inner['agentId'] === 'string' ||
    typeof inner['id'] === 'string' ||
    typeof inner['address'] === 'string';

  if (!hasIdentity) return null; // unrecognised shape — refuse rather than guess

  const eps = inner['endpoints'];
  const endpointCount = Array.isArray(eps)
    ? eps.length
    : typeof inner['endpointCount'] === 'number'
      ? inner['endpointCount']
      : null;

  return { known: true, endpointCount };
}

export class Scan8004CrossReference implements CrossReferenceSource {
  readonly name = '8004scan';
  readonly #pacer: Pacer;

  constructor(private readonly opts: Scan8004Options & { apiKey: string }) {
    const rpm = opts.requestsPerMinute ?? DEFAULTS.requestsPerMinute;
    this.#pacer = new Pacer(Math.ceil(60_000 / Math.max(1, rpm)));
  }

  #url(agent: AgentId): string {
    const base = (this.opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, '');
    return `${base}/agents/${agent.chain}/${agent.tokenId.toString()}`;
  }

  async lookup(agents: readonly AgentId[]): Promise<CrossReferenceResult> {
    const checkedAt = new Date();
    if (agents.length === 0) {
      return { source: this.name, status: 'ok', records: [], checkedAt };
    }

    const records: CrossReferenceRecord[] = [];
    let unrecognised = 0;
    let failed = 0;

    const width = Math.max(1, this.opts.concurrency ?? DEFAULTS.concurrency);
    let cursor = 0;

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = cursor;
        cursor += 1;
        if (i >= agents.length) return;
        const agent = agents[i]!;

        await this.#pacer.wait();
        try {
          const res = await safeFetch(this.#url(agent), {
            timeoutMs: this.opts.timeoutMs ?? DEFAULTS.timeoutMs,
            headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json' },
            ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
          });

          if (res.status === 404) {
            records.push({ agent, knownToSource: false, endpointCount: null, sourceUrl: null });
            continue;
          }
          if (res.status < 200 || res.status >= 300) {
            failed += 1;
            continue;
          }

          const parsed = parseAgentPayload(JSON.parse(res.body) as unknown);
          if (parsed === null) {
            unrecognised += 1;
            continue;
          }
          records.push({
            agent,
            knownToSource: parsed.known,
            endpointCount: parsed.endpointCount,
            sourceUrl: parsed.known ? this.#url(agent) : null,
          });
        } catch {
          // Network error, SSRF refusal, timeout, unparseable JSON. All the
          // same to a caller who must not be blocked by any of them.
          failed += 1;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(width, agents.length) }, worker));

    // If nothing came back at all, saying "0% agreement" would be a lie about
    // the agents rather than a fact about the source.
    if (records.length === 0) {
      return {
        source: this.name,
        status: 'unavailable',
        records: [],
        checkedAt,
        note: `no usable response for ${agents.length} agents (${failed} failed, ${unrecognised} unrecognised)`,
      };
    }

    return {
      source: this.name,
      status: 'ok',
      records,
      checkedAt,
      ...(failed + unrecognised > 0
        ? { note: `${failed} request(s) failed, ${unrecognised} unrecognised response(s); omitted from the comparison` }
        : {}),
    };
  }
}

/**
 * Composition helper. **This is the whole activation story:** drop
 * `ALTLAYER_8004SCAN_API_KEY` into the environment and cross-referencing turns
 * on. Leave it out and everything downstream keeps working against a no-op.
 */
export function buildCrossReference(opts: Scan8004Options = {}): CrossReferenceSource {
  if (opts.apiKey === undefined || opts.apiKey.trim() === '') return nullCrossReference('8004scan');
  return new Scan8004CrossReference({ ...opts, apiKey: opts.apiKey });
}
