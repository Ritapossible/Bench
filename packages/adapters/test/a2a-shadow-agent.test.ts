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
