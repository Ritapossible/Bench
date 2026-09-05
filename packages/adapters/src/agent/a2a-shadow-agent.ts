import { BenchError, type AgentEndpoint, type AgentId } from '@bench/core';
import type { ShadowAgent, ShadowAgentContext } from '@bench/core';
import { safeFetch } from '../net/safe-fetch.js';
import { resolveA2AServiceUrl } from './a2a-service-url.js';

/**
 * Drives a registered A2A agent through an audition.
 *
 * This is the shim ARCHITECTURE.md 2 describes: the agent is not asked to
 * implement a dry-run interface - almost none do - it is handed an RPC endpoint
 * and a task and left to behave. That endpoint points at the interceptor, so
 * every transaction it produces is simulated against forked state and recorded,
 * and the agent cannot tell it is not live.
 *
 * **An agent that refuses to be driven is a result, not an error.** A 404, a
 * timeout, a malformed reply: each is recorded as a failed audition with its
 * reason, because "this agent could not be made to do anything" is precisely
 * the finding a catalog of mostly-dead agents exists to publish. The runner
 * catches it and keeps whatever the agent did before failing.
 *
 * Goes through `safeFetch` for the same reason the prober does: the URL comes
 * from a stranger's agent card, and registration is gas-free.
 */

export interface A2AShadowAgentOptions {
  readonly id: AgentId;
  readonly name: string;
  readonly endpoint: AgentEndpoint;
  readonly timeoutMs?: number;
  /** Name-resolution budget, separate from the request budget. */
  readonly dnsTimeoutMs?: number;
  /** Tests point at 127.0.0.1. Never enable in the worker. */
  readonly allowLoopback?: boolean;
  /**
   * Test seam, matching `AuditionRunner.httpFetch`.
   *
   * The budgets this shim passes are the whole subject of one bug already, and
   * a loopback server cannot observe them: an IP literal skips resolution, so
   * the DNS budget is unobservable through the only other seam here.
   */
  readonly fetchImpl?: typeof safeFetch;
}

const DEFAULT_TIMEOUT_MS = 90_000;
/**
 * Name resolution gets its own budget, and it has to be generous here.
 *
 * `safeFetch` defaults it to 3s, which is right for the prober: that queue
 * does nothing but resolve and fetch. An audition is the opposite - each run
 * holds a forked chain, an anvil process and a stream of RPC calls, and
 * `dns.lookup` is bound by the libuv threadpool those are already competing
 * for. So a 90-second request budget sat behind a 3-second DNS budget, and
 * agents whose hosts the prober reaches in 171ms were recorded as "could not
 * be driven - DNS lookup timed out". The agent was fine; the lookup was
 * queued behind our own fork.
 */
const DEFAULT_DNS_TIMEOUT_MS = 20_000;

/**
 * The task an agent is given.
 *
 * Explicit about the RPC endpoint and the controller account in both the prose
 * and the metadata: an agent that cannot be told where to act cannot be
 * auditioned, and putting it only in prose would make this depend on the
 * agent's language model rather than on its wiring.
 */
function taskText(ctx: ShadowAgentContext): string {
  return [
    `You are being evaluated on a ${ctx.position.kind} position: ${ctx.position.label}.`,
    `Act on it using JSON-RPC endpoint ${ctx.rpcUrl} (BNB Smart Chain).`,
    `The account holding the position is ${ctx.controller}.`,
    `Window ${ctx.window.label} (regime: ${ctx.window.regime}).`,
    'Manage the position as you normally would, submitting transactions to that endpoint.',
  ].join(' ');
}

export class A2AShadowAgent implements ShadowAgent {
  readonly id: string;
  readonly name: string;

  constructor(private readonly opts: A2AShadowAgentOptions) {
    this.id = `${opts.id.chain}:${opts.id.tokenId.toString()}`;
    this.name = opts.name;
  }

  async run(ctx: ShadowAgentContext): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `bench-${Date.now()}`,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [{ kind: 'text', text: taskText(ctx) }],
          messageId: `bench-${this.id}-${ctx.window.id}`,
        },
        // Alongside the prose, not instead of it: an agent that reads structured
        // input should not have to parse an address out of a sentence.
        metadata: {
          rpcUrl: ctx.rpcUrl,
          account: ctx.controller,
          position: { kind: ctx.position.kind, label: ctx.position.label },
          window: { id: ctx.window.id, regime: ctx.window.regime },
        },
      },
    });

    const fetchOne = this.opts.fetchImpl ?? safeFetch;
    /**
     * The registered endpoint is usually the agent card, not the service.
     *
     * Driving it directly is what produced `HTTP 404` and `HTTP 405` on every
     * A2A agent in the catalog: a static card file answers GET and refuses
     * POST. The card names the JSON-RPC address in its own `url`, so this
     * follows it; a registration that already points at a service is returned
     * unchanged and costs nothing.
     */
    const target = await resolveA2AServiceUrl(this.opts.endpoint.url, {
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      dnsTimeoutMs: this.opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
      ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
      fetchImpl: fetchOne,
    });

    const res = await fetchOne(target, {
      method: 'POST',
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      dnsTimeoutMs: this.opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
    });

    if (res.status < 200 || res.status >= 300) {
      throw new BenchError(
        'ENDPOINT_UNREACHABLE',
        `agent returned HTTP ${res.status} to the audition task`,
      );
    }

    // A JSON-RPC error reply is the agent declining the task. Raised so the
    // audition records why, rather than passing as a silent no-op that would
    // score as "chose to do nothing" - a different and much kinder finding.
    let payload: unknown;
    try {
      payload = JSON.parse(res.body);
    } catch {
      throw new BenchError('PROTOCOL_NONCONFORMANT', 'agent reply was not JSON');
    }
    if (payload !== null && typeof payload === 'object' && 'error' in payload) {
      const err = (payload as { error?: { message?: unknown } }).error;
      const message = typeof err?.message === 'string' ? err.message : 'unspecified';
      throw new BenchError('PROTOCOL_NONCONFORMANT', `agent rejected the task: ${message}`);
    }
  }
}
