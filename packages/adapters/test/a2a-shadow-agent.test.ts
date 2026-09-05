import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentId, ShadowAgentContext } from '@bench/core';
import { A2AShadowAgent } from '../src/agent/a2a-shadow-agent.js';

const ID: AgentId = { chain: 'bsc-testnet', tokenId: 42n };

let server: Server | undefined;
afterEach(async () => {
  if (server !== undefined) await new Promise<void>((r) => server?.close(() => r()));
  server = undefined;
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  return `http://127.0.0.1:${port}/a2a`;
}

const ctx = (): ShadowAgentContext => ({
  rpcUrl: 'http://127.0.0.1:9999',
  controller: `0x${'22'.repeat(20)}`,
  window: {
    id: 'w1',
    label: 'March crash',
    regime: 'crash',
    forkBlock: 1n,
    endBlock: 2n,
    seed: 's',
  },
  position: {
    kind: 'spot-balance',
    label: '10,000 USDT',
    params: {},
    capital: {
      token: '0x55d398326f99059ff775485246999027b3197955',
      symbol: 'USDT',
      decimals: 18,
      amount: 10_000n * 10n ** 18n,
    },
  },
  fetch: async () => new Response('{}'),
});

const build = (url: string) =>
  new A2AShadowAgent({
    id: ID,
    name: 'Test Agent',
    endpoint: { protocol: 'a2a', url },
    allowLoopback: true,
    timeoutMs: 3_000,
  });

describe('A2AShadowAgent', () => {
  it('sends an A2A message/send task carrying the fork RPC and the controller', async () => {
    // The agent has to be *told* where to act. Burying the endpoint in prose
    // alone would make this depend on the agent's language model rather than
    // on its wiring, so it goes in structured metadata as well.
    let body: Record<string, unknown> = {};
    const url = await listen((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'completed' } }));
      });
    });

    const c = ctx();
    await build(url).run(c);

    expect(body['method']).toBe('message/send');
    const params = body['params'] as Record<string, unknown>;
    const meta = params['metadata'] as Record<string, unknown>;
    expect(meta['rpcUrl']).toBe(c.rpcUrl);
    expect(meta['account']).toBe(c.controller);

    const message = params['message'] as { parts: { text: string }[] };
    expect(message.parts[0]?.text).toContain(c.rpcUrl);
    expect(message.parts[0]?.text).toContain(c.controller);
  });

  it('raises on a non-2xx, so the audition records why', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    await expect(build(url).run(ctx())).rejects.toThrow(/HTTP 404/);
  });

  it('treats a JSON-RPC error as the agent declining the task', async () => {
    // Not a silent no-op. Swallowing this would score the agent as "chose to do
    // nothing", which is a much kinder finding than "refused the task".
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { message: 'unsupported task' } }));
    });
    await expect(build(url).run(ctx())).rejects.toThrow(/unsupported task/);
  });

  it('raises when the reply is not JSON', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>hello</html>');
    });
    await expect(build(url).run(ctx())).rejects.toThrow(/not JSON/);
  });

  it('accepts a well-formed result', async () => {
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { status: 'completed' } }));
    });
    await expect(build(url).run(ctx())).resolves.toBeUndefined();
  });

  it('refuses a loopback endpoint unless explicitly allowed', async () => {
    // The URL comes from a stranger's agent card and registration is gas-free,
    // so an endpoint pointing at our own infrastructure must not be fetched.
    const url = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const guarded = new A2AShadowAgent({
      id: ID,
      name: 'Test Agent',
      endpoint: { protocol: 'a2a', url },
      timeoutMs: 3_000,
    });
    await expect(guarded.run(ctx())).rejects.toThrow();
  });
});

describe('name resolution under audition load', () => {
  it('gives DNS a budget proportional to the request it precedes', async () => {
    // A 90-second request budget sat behind safeFetch's 3-second DNS default,
    // and an audition holds a forked chain and an anvil process competing for
    // the same libuv threadpool that dns.lookup uses. Agents whose hosts the
    // prober reached in 171ms were recorded as "could not be driven - DNS
    // lookup timed out after 3000ms". The endpoint was fine; the lookup was
    // queued behind our own fork.
    const seen: { timeoutMs?: number; dnsTimeoutMs?: number }[] = [];

    const agent = new A2AShadowAgent({
      id: { chain: 'bsc-testnet', tokenId: 1n },
      name: 'probe',
      endpoint: { protocol: 'a2a', url: 'https://agent.example/a2a' },
      fetchImpl: (async (_url: string, opts?: { timeoutMs?: number; dnsTimeoutMs?: number }) => {
        seen.push(opts ?? {});
        return {
          status: 200,
          body: '{"result":{}}',
          headers: new Headers(),
          truncated: false,
          latencyMs: 1,
          finalUrl: _url,
        };
      }) as never,
    });

    await agent.run({
      rpcUrl: 'http://127.0.0.1:1',
      controller: `0x${'11'.repeat(20)}`,
      window: { id: 'w', label: 'w', regime: 'live', forkBlock: 1n, endBlock: 2n, seed: 's' },
      position: {
        kind: 'spot-balance',
        label: 'p',
        params: {},
        capital: { token: `0x${'22'.repeat(20)}`, symbol: 'U', decimals: 18, amount: 1n },
      },
      fetch: (async () => new Response('{}')) as never,
    });

    expect(seen[0]?.dnsTimeoutMs ?? 0).toBeGreaterThanOrEqual(15_000);
    // Separate budgets, not one reused: resolution must not be able to consume
    // the whole request window.
    expect(seen[0]?.dnsTimeoutMs ?? 0).toBeLessThan(seen[0]?.timeoutMs ?? 0);
  });
});

describe('a registration that points at the agent card', () => {
  it('posts the task to the service the card names, not to the card', async () => {
    /**
     * The bug this pins, from BSC testnet agent 1825: the registration's A2A
     * `endpoint` is the well-known card path, and the card there carries the
     * JSON-RPC address. Bench POSTed `message/send` at the card file, a static
     * JSON file refused POST, and the catalog recorded "agent returned HTTP
     * 404 to the audition task". The agent answers `message/send` on its real
     * url; it was alive the whole time.
     */
    const card = 'https://proofera-lp.tangvu.dev/.well-known/agent-card.json';
    const service = 'https://proofera-lp.tangvu.dev/';
    const calls: { url: string; method: string | undefined }[] = [];

    const agent = new A2AShadowAgent({
      id: { chain: 'bsc-testnet', tokenId: 1825n },
      name: 'ProofEra LP Risk Evidence Agent',
      endpoint: { protocol: 'a2a', url: card },
      fetchImpl: (async (url: string, opts?: { method?: string }) => {
        calls.push({ url, method: opts?.method });
        // The card file: readable, and refuses the POST an audition makes.
        if (url === card) {
          return opts?.method === 'POST'
            ? { status: 404, body: '', headers: new Headers(), truncated: false, latencyMs: 1 }
            : {
                status: 200,
                body: JSON.stringify({ name: 'ProofEra', url: service }),
                headers: new Headers(),
                truncated: false,
                latencyMs: 1,
              };
        }
        return {
          status: 200,
          body: '{"jsonrpc":"2.0","id":1,"result":{"kind":"message"}}',
          headers: new Headers(),
          truncated: false,
          latencyMs: 1,
        };
      }) as never,
    });

    await agent.run({
      rpcUrl: 'http://127.0.0.1:1',
      controller: `0x${'11'.repeat(20)}`,
      window: { id: 'w', label: 'w', regime: 'live', forkBlock: 1n, endBlock: 2n, seed: 's' },
      position: {
        kind: 'spot-balance',
        label: 'p',
        params: {},
        capital: { token: `0x${'22'.repeat(20)}`, symbol: 'U', decimals: 18, amount: 1n },
      },
      fetch: (async () => new Response('{}')) as never,
    });

    expect(calls).toEqual([
      { url: card, method: 'GET' },
      { url: service, method: 'POST' },
    ]);
  });
});
