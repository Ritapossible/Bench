import { BenchError, type AgentEndpoint, type AgentId } from '@bench/core';
import type { ShadowAgent, ShadowAgentContext } from '@bench/core';
import { safeFetch } from '../net/safe-fetch.js';
import { resolveA2AService } from './a2a-service-url.js';
import { attemptsFor, type A2APart } from './a2a-envelope.js';
import { assertA2AAccepted, isRunningState, readA2AReply } from './a2a-reply.js';

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
/** Gap between `tasks/get` polls while an agent is still working. */
const POLL_INTERVAL_MS = 2_000;

export class A2AShadowAgent implements ShadowAgent {
  readonly id: string;
  readonly name: string;

  constructor(private readonly opts: A2AShadowAgentOptions) {
    this.id = `${opts.id.chain}:${opts.id.tokenId.toString()}`;
    this.name = opts.name;
  }

  async run(ctx: ShadowAgentContext): Promise<void> {
    const fetchOne = this.opts.fetchImpl ?? safeFetch;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const dnsTimeoutMs = this.opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS;

    /**
     * The registered endpoint is usually the agent card, not the service.
     *
     * Driving it directly is what produced `HTTP 404` and `HTTP 405` on every
     * A2A agent in the catalog: a static card file answers GET and refuses
     * POST. The card names the JSON-RPC address in its own `url`, so this
     * follows it; a registration that already points at a service is returned
     * unchanged and costs nothing. The card comes back too, because it also
     * says what shape of request the agent takes.
     */
    const service = await resolveA2AService(this.opts.endpoint.url, {
      timeoutMs,
      dnsTimeoutMs,
      ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
      fetchImpl: fetchOne,
    });

    /**
     * Ask in the shapes the card declares, best first, and stop at the first
     * one the agent accepts.
     *
     * A cooperative agent costs one request. The retries exist because a
     * refusal like "INVALID_A2A_ENVELOPE" is the agent saying Bench asked
     * wrongly, and giving up there records a fact about Bench as though it
     * were a fact about the agent. What varies between attempts is only the
     * envelope the card asked for - never the task, never the position.
     */
    const attempts = attemptsFor(ctx, service.card);
    /**
     * The first refusal is the one kept, not the last.
     *
     * A card lists its primary skill first, so the first attempt is the
     * closest thing the agent offers to what was asked - and its complaint is
     * the informative one. ProofEra's first says it wants `poolAddress` and
     * `positionId`, which tells a reader it analyses V3 LP positions and was
     * handed a spot balance. Its second is about a permission bundle nobody
     * asked for. Reporting the last attempt would have published the least
     * relevant sentence the agent said.
     */
    let firstRefusal: BenchError | null = null;

    for (const part of attempts) {
      try {
        await this.#ask(service.url, part, ctx, fetchOne, timeoutMs, dnsTimeoutMs);
        return;
      } catch (err) {
        // Only a refusal is worth another shape. An unreachable host, a
        // non-JSON reply or an unfinished task says nothing about the envelope
        // and retrying would just spend the run's budget.
        if (!(err instanceof BenchError) || err.code !== 'PROTOCOL_NONCONFORMANT') throw err;
        firstRefusal ??= err;
      }
    }

    if (firstRefusal === null) {
      throw new BenchError('PROTOCOL_NONCONFORMANT', 'agent accepted no request');
    }
    // Say how many were tried, so a refusal cannot be read as Bench giving up
    // after one guess at the envelope.
    const tried =
      attempts.length === 1 ? '' : ` (all ${attempts.length} shapes its card declares were tried)`;
    throw new BenchError('PROTOCOL_NONCONFORMANT', `${firstRefusal.message}${tried}`);
  }

  /** One `message/send`, followed to a settled state. */
  async #ask(
    target: string,
    part: A2APart,
    ctx: ShadowAgentContext,
    fetchOne: typeof safeFetch,
    timeoutMs: number,
    dnsTimeoutMs: number,
  ): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: `bench-${Date.now()}`,
      method: 'message/send',
      params: {
        message: {
          role: 'user',
          parts: [part],
          messageId: `bench-${this.id}-${ctx.window.id}`,
        },
        // Alongside the parts, not instead of them: an agent that reads
        // structured input should not have to parse an address out of a
        // sentence.
        metadata: {
          rpcUrl: ctx.rpcUrl,
          account: ctx.controller,
          accountPrivateKey: ctx.controllerKey,
          position: { kind: ctx.position.kind, label: ctx.position.label },
          window: { id: ctx.window.id, regime: ctx.window.regime },
        },
      },
    });

    const res = await fetchOne(target, {
      method: 'POST',
      timeoutMs,
      dnsTimeoutMs,
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
      ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
    });

    if (res.status < 200 || res.status >= 300) {
      /**
       * Name the address that answered, and who chose it.
       *
       * "agent returned HTTP 404 to the audition task" reads as though Bench
       * knocked on the wrong door. Usually it did not: the registration points
       * at an agent card, the card names a service in its own `url`, and that
       * is where the task was POSTed. A real example from the mainnet catalog
       * is an agent whose card sends every client to its marketing site, which
       * 404s, while the service itself sits on a different host entirely.
       * Without the chain in the message, that is indistinguishable from a bug
       * here - and the agent's owner cannot see what to fix.
       */
      const registered = this.opts.endpoint.url;
      const via =
        target === registered
          ? ` at ${target}`
          : ` at ${target}, the address its own agent card declares (registered as ${registered})`;

      /**
       * 402 is an answer, not a silence.
       *
       * An agent charging for its work has told Bench something specific and
       * deliberate, and filing that under "registered, but nothing usable
       * answered" would be a fact about a working agent published as a broken
       * one. It declines, for a reason the catalog can state.
       */
      if (res.status === 402) {
        throw new BenchError(
          'PROTOCOL_NONCONFORMANT',
          `agent requires payment before it will take a task (HTTP 402${via})`,
        );
      }
      throw new BenchError(
        'ENDPOINT_UNREACHABLE',
        `agent returned HTTP ${res.status} to the audition task${via}`,
      );
    }

    // A JSON-RPC error reply is the agent declining the task. Raised so the
    // audition records why, rather than passing as a silent no-op that would
    // score as "chose to do nothing" - a different and much kinder finding.
    const payload = parseReply(res.body);
    if ('error' in payload) {
      const err = (payload as { error?: { message?: unknown } }).error;
      const message = typeof err?.message === 'string' ? err.message : 'unspecified';
      throw new BenchError('PROTOCOL_NONCONFORMANT', `agent rejected the task: ${message}`);
    }

    /**
     * The refusal is usually inside `result`, not beside it.
     *
     * Both live A2A agents in the first real report answered 200 with a
     * well-formed JSON-RPC success whose data part said "INVALID_A2A_ENVELOPE"
     * and "unknown skill: None". Reading only the envelope recorded those as
     * completed auditions of zero actions - a refusal published as a
     * measurement.
     */
    let reply = readA2AReply((payload as { result?: unknown }).result);

    /**
     * An accepted task is not a finished one.
     *
     * `message/send` may answer with a Task in `submitted` or `working`, which
     * means the agent has taken the job and is still on it. Returning then
     * measures a fork the agent has not touched yet, so this polls `tasks/get`
     * until the task settles or the run's own budget is gone - the same budget
     * the request had, not a new one.
     */
    if (reply.kind === 'task' && isRunningState(reply.state) && reply.taskId !== null) {
      reply = await this.#awaitTask(target, reply.taskId, fetchOne);
    }

    assertA2AAccepted(reply);
  }

  /** Poll one task to a settled state, or to the end of the budget. */
  async #awaitTask(
    target: string,
    taskId: string,
    fetchOne: typeof safeFetch,
  ): Promise<ReturnType<typeof readA2AReply>> {
    const budgetMs = this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const deadline = Date.now() + budgetMs;
    let reply = readA2AReply(undefined);

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      const res = await fetchOne(target, {
        method: 'POST',
        timeoutMs: remaining,
        dnsTimeoutMs: this.opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `bench-poll-${Date.now()}`,
          method: 'tasks/get',
          params: { id: taskId },
        }),
      });
      // A server that will not answer tasks/get leaves the last known state
      // standing, which is `working` - reported as unfinished, not as done.
      if (res.status < 200 || res.status >= 300) break;

      const payload = parseReply(res.body);
      if ('error' in payload) break;
      reply = readA2AReply((payload as { result?: unknown }).result);
      if (!isRunningState(reply.state)) return reply;
    }

    return reply.state === null ? { kind: 'task', taskId, state: 'working', refusal: null } : reply;
  }
}

/** JSON or a refusal. Shared by the send and the poll. */
function parseReply(body: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BenchError('PROTOCOL_NONCONFORMANT', 'agent reply was not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new BenchError('PROTOCOL_NONCONFORMANT', 'agent reply was not a JSON-RPC object');
  }
  return parsed as Record<string, unknown>;
}
