import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * ============================================================================
 * The bridge between a forked chain and an agent that is not on this machine.
 * ============================================================================
 *
 * The audition premise is that an agent is handed an RPC endpoint it cannot
 * tell from a real node. The interceptor implements that faithfully - and
 * binds to 127.0.0.1, because an RPC that can mint balances and impersonate
 * accounts must never be reachable from outside the host.
 *
 * Both of those are correct, and together they made the product impossible.
 * The A2A and MCP shims POST `rpcUrl` to an agent running on someone else's
 * infrastructure, and that URL was `http://127.0.0.1:<port>`. No remote agent
 * could ever reach it, so none could ever submit a transaction, so
 * `deltaVsDoNothingUsd` - terminal minus do-nothing on a position nothing
 * touched - was exactly zero for every agent, permanently. Production bore
 * that out precisely: one completed audition, $44,373 with the agent and
 * $44,373 without, zero transactions. Not a thin sample; the only result the
 * architecture could produce.
 *
 * This is the missing piece. The interceptor stays loopback-bound. A gateway
 * on the worker's one public port forwards `POST /rpc/<token>` to it, where
 * the token is 32 bytes of CSPRNG minted per run and forgotten when the fork
 * is destroyed. So the fork is reachable by exactly one agent, for exactly the
 * length of one audition, and by nobody else ever.
 *
 * One public port because that is what a container host gives you. Railway,
 * Fly and Cloud Run all publish a single port; binding a fresh public port per
 * fork works on a laptop and nowhere the worker actually runs.
 */

/** Registered forks, by the token that reaches them. */
interface Route {
  readonly localUrl: string;
  readonly runId: string;
  readonly createdAt: number;
}

export interface RpcGatewayOptions {
  /**
   * Public origin the worker is reachable at, e.g.
   * `https://bench-worker.up.railway.app`. Absent means no public routing is
   * possible, and the gateway hands back loopback URLs - correct for local
   * development and tests, and useless against a remote agent, which is why
   * the worker says so at boot.
   */
  readonly publicBaseUrl?: string | undefined;
  /**
   * How long a route may live. A fork that is destroyed unregisters itself;
   * this is the backstop for a crash between the two, so a leaked route cannot
   * outlive the process it belonged to.
   */
  readonly maxRouteAgeMs?: number;
}

const DEFAULT_MAX_ROUTE_AGE_MS = 30 * 60_000;
/** JSON-RPC bodies are small. This is a bound on a stranger's request. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface RpcRoute {
  /** What the agent is told. Public when configured, loopback otherwise. */
  readonly url: string;
  readonly token: string;
}

export class RpcGateway {
  readonly #routes = new Map<string, Route>();

  constructor(private readonly opts: RpcGatewayOptions = {}) {}

  /** True when a remote agent can actually reach a registered fork. */
  get publiclyRoutable(): boolean {
    return this.#base() !== null;
  }

  #base(): string | null {
    const raw = this.opts.publicBaseUrl;
    if (raw === undefined || raw.trim() === '') return null;
    try {
      // Normalised so a trailing slash or a stray path cannot produce
      // `https://host//rpc/<token>`, which some agents will not follow.
      return new URL(raw).origin;
    } catch {
      return null;
    }
  }

  /**
   * Publish one fork's interceptor under a fresh unguessable token.
   *
   * The token is the whole access control. It is not a secret shared with
   * anyone but the one agent being auditioned, it is never logged, and it
   * stops working the moment the run ends.
   */
  register(localUrl: string, runId: string): RpcRoute {
    this.#evictExpired();
    const token = randomBytes(32).toString('hex');
    this.#routes.set(token, { localUrl, runId, createdAt: Date.now() });
    const base = this.#base();
    return {
      token,
      url: base === null ? localUrl : `${base}/rpc/${token}`,
    };
  }

  unregister(token: string): void {
    this.#routes.delete(token);
  }

  get size(): number {
    return this.#routes.size;
  }

  #evictExpired(): void {
    const max = this.opts.maxRouteAgeMs ?? DEFAULT_MAX_ROUTE_AGE_MS;
    const cutoff = Date.now() - max;
    for (const [token, route] of this.#routes) {
      if (route.createdAt < cutoff) this.#routes.delete(token);
    }
  }

  /**
   * Handle a request if it addresses this gateway; return false otherwise so
   * the caller can serve its own routes on the same port.
   */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    if (!path.startsWith('/rpc/')) return false;

    const token = path.slice('/rpc/'.length).replace(/\/$/, '');
    const route = this.#routes.get(token);

    // Same answer for an unknown token and an expired one: a gateway that
    // distinguishes them tells a scanner which of its guesses was once real.
    if (
      route === undefined ||
      Date.now() - route.createdAt > (this.opts.maxRouteAgeMs ?? DEFAULT_MAX_ROUTE_AGE_MS)
    ) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32601, message: 'no such audition' },
        }),
      );
      return true;
    }

    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'JSON-RPC is POST' },
        }),
      );
      return true;
    }

    let body: Buffer;
    try {
      body = await readBounded(req, MAX_BODY_BYTES);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'request too large' },
        }),
      );
      return true;
    }

    try {
      const upstream = await fetch(route.localUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
      const text = await upstream.text();
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(text);
    } catch {
      // Never forward the upstream error text: it names a loopback port and
      // would describe this host's internals to whoever is driving the agent.
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32603, message: 'fork unavailable' },
        }),
      );
    }
    return true;
  }
}

async function readBounded(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
