import {
  BenchError,
  type AgentEndpoint,
  type AgentId,
  type ProbeClient,
  type ProbeResult,
} from '@bench/core';
import { safeFetch, type SafeResponse } from '../net/safe-fetch.js';

/**
 * The prober. Powers the "verified live" filter.
 *
 * The distinction this class exists to draw is **reachable vs conformant**.
 * Plenty of declared endpoints return HTTP 200 — a parked domain, an nginx
 * default page, an unrelated API — without implementing the protocol on the
 * agent card. Counting those as live would rebuild the same empty directory
 * Bench exists to replace, just with a green dot on it. So every probe does
 * two things: touch the endpoint, then make it prove the protocol.
 *
 * Every conformance check below is **read-only**. We probe strangers' agents
 * on a schedule; a check with side effects would make Bench a nuisance at
 * best and an attacker at worst.
 */

export interface ProbeOptions {
  readonly timeoutMs?: number;
  /** Name resolution budget, separate from the request. See SafeFetchOptions. */
  readonly dnsTimeoutMs?: number;
  /** Tests only — allows 127.0.0.1 targets. Never enable in the worker. */
  readonly allowLoopback?: boolean;
}

interface Conformance {
  readonly conformant: boolean;
  readonly detail: string;
}

export class HttpProbeClient implements ProbeClient {
  constructor(private readonly opts: ProbeOptions = {}) {}

  async probe(agent: AgentId, endpoint: AgentEndpoint): Promise<ProbeResult> {
    const at = new Date();
    const base = {
      timeoutMs: this.opts.timeoutMs ?? 5_000,
      dnsTimeoutMs: this.opts.dnsTimeoutMs ?? 3_000,
      allowLoopback: this.opts.allowLoopback ?? false,
    } as const;

    try {
      const check = await this.checkProtocol(endpoint, base);
      return {
        agent,
        endpoint,
        at,
        reachable: true,
        latencyMs: check.latencyMs,
        conformant: check.conformant,
        // A reachable-but-nonconformant endpoint is the interesting case, so
        // the reason is recorded even on success. It is what lets an agent
        // owner see why their agent is not listed as live.
        ...(check.conformant ? {} : { error: check.detail }),
      };
    } catch (err) {
      const message = err instanceof BenchError ? err.message : String(err);
      return {
        agent,
        endpoint,
        at,
        reachable: false,
        latencyMs: null,
        conformant: false,
        error: message,
      };
    }
  }

  private async checkProtocol(
    endpoint: AgentEndpoint,
    base: { timeoutMs: number; dnsTimeoutMs: number; allowLoopback: boolean },
  ): Promise<Conformance & { latencyMs: number }> {
    switch (endpoint.protocol) {
      case 'a2a':
        return this.checkA2A(endpoint.url, base);
      case 'mcp':
        return this.checkMcp(endpoint.url, base);
      case 'oasf':
        return this.checkOasf(endpoint.url, base);
      default: {
        const exhaustive: never = endpoint.protocol;
        throw new BenchError('PROTOCOL_NONCONFORMANT', `unknown protocol ${String(exhaustive)}`);
      }
    }
  }

  /**
   * A2A: the agent card is published at a well-known path. Conformant means a
   * card that parses and declares both an identity and a capability surface —
   * the minimum for another agent to actually address this one.
   */
  private async checkA2A(
    url: string,
    base: { timeoutMs: number; dnsTimeoutMs: number; allowLoopback: boolean },
  ): Promise<Conformance & { latencyMs: number }> {
    const origin = originOf(url);
    const candidates = [
      `${origin}/.well-known/agent.json`,
      `${origin}/.well-known/agent-card.json`,
    ];

    let latencyMs = 0;
    let lastDetail = 'no A2A agent card at either well-known path';

    for (const candidate of candidates) {
      let res: SafeResponse;
      try {
        res = await safeFetch(candidate, base);
      } catch {
        continue; // try the other path before declaring the host unreachable
      }
      latencyMs = res.latencyMs;
      if (res.status !== 200) {
        lastDetail = `agent card returned HTTP ${res.status}`;
        continue;
      }
      const card = parseJsonObject(res.body);
      if (card === null) {
        lastDetail = 'agent card is not a JSON object';
        continue;
      }
      const hasIdentity = typeof card['name'] === 'string';
      const hasSurface = card['capabilities'] !== undefined || Array.isArray(card['skills']);
      if (hasIdentity && hasSurface) {
        return { conformant: true, detail: 'a2a agent card ok', latencyMs };
      }
      lastDetail = 'agent card missing name or capabilities/skills';
    }

    // The endpoint itself may still answer even with no card. Reaching it is
    // what makes this reachable-but-nonconformant rather than unreachable.
    const probe = await safeFetch(url, base);
    return { conformant: false, detail: lastDetail, latencyMs: latencyMs || probe.latencyMs };
  }

  /**
   * MCP: the `initialize` handshake. It is the one call every MCP server must
   * answer, it is read-only, and a server that cannot answer it is not an MCP
   * server regardless of what the agent card says.
   */
  private async checkMcp(
    url: string,
    base: { timeoutMs: number; dnsTimeoutMs: number; allowLoopback: boolean },
  ): Promise<Conformance & { latencyMs: number }> {
    const res = await safeFetch(url, {
      ...base,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Streamable-HTTP servers may reply with either; accept both.
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'bench-prober', version: '0.1.0' },
        },
      }),
    });

    if (res.status !== 200) {
      return {
        conformant: false,
        detail: `initialize returned HTTP ${res.status}`,
        latencyMs: res.latencyMs,
      };
    }

    const payload = parseJsonObject(extractSseData(res.body));
    if (payload === null) {
      return {
        conformant: false,
        detail: 'initialize response is not JSON-RPC',
        latencyMs: res.latencyMs,
      };
    }
    if (payload['jsonrpc'] !== '2.0') {
      return { conformant: false, detail: 'response is not jsonrpc 2.0', latencyMs: res.latencyMs };
    }
    const result = payload['result'];
    if (typeof result !== 'object' || result === null) {
      const err = payload['error'];
      const detail =
        typeof err === 'object' && err !== null
          ? `initialize errored: ${JSON.stringify(err).slice(0, 120)}`
          : 'initialize returned no result';
      return { conformant: false, detail, latencyMs: res.latencyMs };
    }
    const rec = result as Record<string, unknown>;
    if (typeof rec['protocolVersion'] !== 'string' || rec['capabilities'] === undefined) {
      return {
        conformant: false,
        detail: 'initialize result missing protocolVersion or capabilities',
        latencyMs: res.latencyMs,
      };
    }
    return { conformant: true, detail: 'mcp initialize ok', latencyMs: res.latencyMs };
  }

  /**
   * OASF: descriptor fetch. The weakest of the three checks — the schema is
   * the least settled of the three — so it verifies only that a structured
   * descriptor with a declared schema and identity comes back.
   */
  private async checkOasf(
    url: string,
    base: { timeoutMs: number; dnsTimeoutMs: number; allowLoopback: boolean },
  ): Promise<Conformance & { latencyMs: number }> {
    const res = await safeFetch(url, base);
    if (res.status !== 200) {
      return { conformant: false, detail: `HTTP ${res.status}`, latencyMs: res.latencyMs };
    }
    const doc = parseJsonObject(res.body);
    if (doc === null) {
      return {
        conformant: false,
        detail: 'descriptor is not a JSON object',
        latencyMs: res.latencyMs,
      };
    }
    const hasSchema =
      typeof doc['schema_version'] === 'string' || typeof doc['schemaVersion'] === 'string';
    const hasIdentity = typeof doc['name'] === 'string';
    return hasSchema && hasIdentity
      ? { conformant: true, detail: 'oasf descriptor ok', latencyMs: res.latencyMs }
      : {
          conformant: false,
          detail: 'descriptor missing schema_version or name',
          latencyMs: res.latencyMs,
        };
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    throw new BenchError('ENDPOINT_UNREACHABLE', `malformed endpoint URL: ${url}`);
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * MCP streamable-HTTP servers may answer a POST with an SSE stream rather than
 * a JSON body. Pull the first `data:` payload out so both transports parse
 * through the same path; plain JSON passes through untouched.
 */
export function extractSseData(body: string): string {
  const trimmed = body.trimStart();
  if (!trimmed.startsWith('event:') && !trimmed.startsWith('data:')) return body;
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) return line.slice('data:'.length).trim();
  }
  return body;
}
