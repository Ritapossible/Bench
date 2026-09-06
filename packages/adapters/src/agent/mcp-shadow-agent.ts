import { BenchError, type AgentEndpoint, type AgentId } from '@bench/core';
import type { ShadowAgent, ShadowAgentContext } from '@bench/core';
import { safeFetch, type SafeResponse } from '../net/safe-fetch.js';
import { extractSseData } from '../probe/http-probe.js';

/**
 * Drives a registered MCP agent through an audition.
 *
 * The counterpart to `A2AShadowAgent`, and its absence was not a gap in
 * coverage so much as a silent exclusion: the worker built a shim only for
 * `a2a`, so every verified-live MCP agent was skipped without being recorded
 * as skipped-and-why. Across tokens 1400-1659 of the registry, MCP is about a
 * third of the publicly-addressable endpoints - so a third of the agents that
 * survive probing could never be auditioned, and the audition queue ran forty
 * times reporting zero failures and doing nothing.
 *
 * MCP has no "send this agent a task" verb the way A2A does. What it has is
 * tools, so the shim does what a client would: initialize, list the tools, pick
 * the one that most plausibly acts on a position, and call it with the task.
 * Choosing by name is a heuristic and is treated as one - a server whose tools
 * cannot be matched fails the audition with what it did offer, which is a
 * finding about the agent rather than a hidden skip.
 */

export interface McpShadowAgentOptions {
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
 * Tool names that plausibly act on a position, most specific first.
 *
 * Ordered so a server offering both `execute_trade` and `get_price` is asked to
 * trade rather than quoted at. A read-only tool is still worth calling when it
 * is all there is: an agent that only reads produces no transactions, scores as
 * having done nothing, and that is the correct result rather than a failure.
 */
const ACTION_HINTS = [
  /rebalance|reallocat/i,
  /execute|submit|send.?tx|transact/i,
  /trade|swap|order|buy|sell/i,
  /manage|optimi[sz]e|harvest|compound/i,
  /analy[sz]e|evaluate|assess|recommend|signal/i,
];

interface McpTool {
  readonly name: string;
  readonly inputSchema?: { readonly properties?: Record<string, unknown> };
}

function chooseTool(tools: readonly McpTool[]): McpTool | null {
  for (const hint of ACTION_HINTS) {
    const hit = tools.find((t) => hint.test(t.name));
    if (hit !== undefined) return hit;
  }
  return tools[0] ?? null;
}

function taskText(ctx: ShadowAgentContext): string {
  return [
    `You are being evaluated on a ${ctx.position.kind} position: ${ctx.position.label}.`,
    `Act on it using JSON-RPC endpoint ${ctx.rpcUrl} (BNB Smart Chain).`,
    `The account holding the position is ${ctx.controller}.`,
    `Window ${ctx.window.label} (regime: ${ctx.window.regime}).`,
    'Manage the position as you normally would, submitting transactions to that endpoint.',
  ].join(' ');
}

/**
 * Fill whatever the tool asked for with the task.
 *
 * A tool's schema is the agent author's, so there is no argument name this can
 * rely on. Every string-shaped top-level property gets the task text and the
 * endpoint, which is cheap and means a server naming its argument `prompt`,
 * `query`, `task` or `input` is all handled without a list of guesses that
 * would go stale.
 */
function argumentsFor(tool: McpTool, ctx: ShadowAgentContext): Record<string, unknown> {
  const props = tool.inputSchema?.properties;
  const task = taskText(ctx);
  if (props === undefined || Object.keys(props).length === 0) {
    return { task, rpcUrl: ctx.rpcUrl, account: ctx.controller };
  }

  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    const type = (schema as { type?: unknown } | null)?.type;
    if (type !== undefined && type !== 'string') continue;
    args[key] = /rpc|endpoint|url|node/i.test(key)
      ? ctx.rpcUrl
      : /account|address|wallet|from/i.test(key)
        ? ctx.controller
        : task;
  }
  return Object.keys(args).length === 0
    ? { task, rpcUrl: ctx.rpcUrl, account: ctx.controller }
    : args;
}

/**
 * The text of a failed `tools/call`, or null when the tool succeeded.
 *
 * Content blocks are the MCP wire format for a tool's reply, and on a failure
 * they carry the reason. Joined and capped, because a server is free to return
 * a stack trace and this ends up on a public page.
 */
export function toolCallError(result: unknown): string | null {
  if (typeof result !== 'object' || result === null || Array.isArray(result)) return null;
  const rec = result as Record<string, unknown>;
  if (rec['isError'] !== true) return null;

  const text = (Array.isArray(rec['content']) ? rec['content'] : [])
    .map((block) => {
      if (typeof block !== 'object' || block === null) return null;
      const t = (block as Record<string, unknown>)['text'];
      return typeof t === 'string' && t !== '' ? t : null;
    })
    .filter((t): t is string => t !== null)
    .join(' ')
    .slice(0, 240);

  return text === '' ? 'the tool reported an error with no message' : text;
}

export class McpShadowAgent implements ShadowAgent {
  readonly id: string;
  readonly name: string;
  #nextId = 1;

  constructor(private readonly opts: McpShadowAgentOptions) {
    this.id = `${opts.id.chain}:${opts.id.tokenId.toString()}`;
    this.name = opts.name;
  }

  async run(ctx: ShadowAgentContext): Promise<void> {
    // Streamable-HTTP servers reply with either JSON or an SSE frame, and the
    // prober already had to handle both, so the parsing is shared.
    await this.#call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bench-audition', version: '0.1.0' },
    });

    const listed = await this.#call('tools/list', {});
    const tools = Array.isArray((listed as { tools?: unknown })?.tools)
      ? ((listed as { tools: McpTool[] }).tools ?? [])
      : [];
    if (tools.length === 0) {
      throw new BenchError('PROTOCOL_NONCONFORMANT', 'MCP server offers no tools to drive');
    }

    const tool = chooseTool(tools);
    if (tool === null || typeof tool.name !== 'string') {
      throw new BenchError(
        'PROTOCOL_NONCONFORMANT',
        `no callable tool among: ${tools
          .map((t) => String(t.name))
          .join(', ')
          .slice(0, 160)}`,
      );
    }

    const called = await this.#call('tools/call', {
      name: tool.name,
      arguments: argumentsFor(tool, ctx),
    });

    /**
     * MCP reports a failed tool call inside `result`, not beside it.
     *
     * `tools/call` answers `{content:[...], isError:true}` on a JSON-RPC
     * success whenever the tool itself refused - a missing argument, an
     * unsupported chain, a rate limit. This returned `payload.result` and
     * looked no further, so a refusal was recorded as a completed audition of
     * zero actions: the same mistake the A2A shim was making one protocol
     * over, where both live agents declined inside `result` and the catalog
     * published the zeros as measured findings.
     */
    const failure = toolCallError(called);
    if (failure !== null) {
      throw new BenchError(
        'PROTOCOL_NONCONFORMANT',
        `tool ${tool.name} declined the task: ${failure}`,
      );
    }
  }

  async #call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const fetchOne = this.opts.fetchImpl ?? safeFetch;
    const res: SafeResponse = await fetchOne(this.opts.endpoint.url, {
      method: 'POST',
      timeoutMs: this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      dnsTimeoutMs: this.opts.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params }),
      ...(this.opts.allowLoopback === true ? { allowLoopback: true } : {}),
    });

    if (res.status < 200 || res.status >= 300) {
      throw new BenchError(
        'ENDPOINT_UNREACHABLE',
        `MCP server returned HTTP ${res.status} to ${method}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(extractSseData(res.body));
    } catch {
      throw new BenchError('PROTOCOL_NONCONFORMANT', `MCP reply to ${method} was not JSON`);
    }

    // A JSON-RPC error is the agent declining, which is a finding rather than a
    // silent no-op that would score as "chose to do nothing".
    if (payload !== null && typeof payload === 'object' && 'error' in payload) {
      const err = (payload as { error?: { message?: unknown } }).error;
      const message = typeof err?.message === 'string' ? err.message : 'unspecified';
      throw new BenchError('PROTOCOL_NONCONFORMANT', `MCP ${method} failed: ${message}`);
    }
    return (payload as { result?: unknown } | null)?.result ?? null;
  }
}
