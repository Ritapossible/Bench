import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BenchError, type ShadowAgentContext } from '@bench/core';
import { McpShadowAgent, toolCallError } from '../src/agent/mcp-shadow-agent.js';

/**
 * MCP agents were skipped entirely: the worker built a shim only for A2A, so a
 * third of the publicly-addressable endpoints in the registry could never be
 * auditioned, and the queue reported zero failures while doing nothing.
 */
let server: Server;
let port = 0;
let calls: { method: string; params: Record<string, unknown> }[] = [];
let tools: unknown[] = [];
let mode: 'json' | 'sse' | 'error' | 'http500' = 'json';

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += String(c)));
    req.on('end', () => {
      const msg = JSON.parse(body) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      calls.push({ method: msg.method, params: msg.params });
      if (mode === 'http500') {
        res.writeHead(500);
        res.end('nope');
        return;
      }
      if (mode === 'error' && msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { message: 'declined' } }));
        return;
      }
      const result =
        msg.method === 'initialize'
          ? { protocolVersion: '2025-06-18', capabilities: {} }
          : msg.method === 'tools/list'
            ? { tools }
            : { content: [{ type: 'text', text: 'done' }] };
      const payload = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
      if (mode === 'sse') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end(`event: message\ndata: ${payload}\n\n`);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(payload);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

const agent = () =>
  new McpShadowAgent({
    id: { chain: 'bsc-testnet', tokenId: 1n },
    name: 'test',
    endpoint: { protocol: 'mcp', url: `http://127.0.0.1:${port}/mcp` },
    allowLoopback: true,
    timeoutMs: 5_000,
  });

const ctx = {
  rpcUrl: 'http://127.0.0.1:8545',
  controller: '0x1111111111111111111111111111111111111111',
  window: {
    id: 'w1',
    label: 'Recent market',
    regime: 'live',
    forkBlock: 1n,
    endBlock: 2n,
    seed: 's',
  },
  position: { kind: 'spot-balance', label: '10,000 USDT', params: {}, capital: {} },
  fetch: globalThis.fetch,
} as unknown as ShadowAgentContext;

describe('McpShadowAgent', () => {
  it('initializes, lists tools, and calls one', async () => {
    calls = [];
    mode = 'json';
    tools = [{ name: 'get_price' }, { name: 'execute_trade' }];
    await agent().run(ctx);
    expect(calls.map((c) => c.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
  });

  it('prefers a tool that acts over one that only reads', async () => {
    // A server offering both should be asked to trade, not quoted at.
    calls = [];
    mode = 'json';
    tools = [{ name: 'get_price' }, { name: 'rebalance_portfolio' }, { name: 'execute_trade' }];
    await agent().run(ctx);
    expect(calls[2]?.params['name']).toBe('rebalance_portfolio');
  });

  it('fills the argument names the tool actually declared', async () => {
    // The schema is the agent author's, so no argument name can be relied on.
    calls = [];
    mode = 'json';
    tools = [
      {
        name: 'act',
        inputSchema: {
          properties: {
            prompt: { type: 'string' },
            rpcEndpoint: { type: 'string' },
            account: { type: 'string' },
            depth: { type: 'number' },
          },
        },
      },
    ];
    await agent().run(ctx);
    const args = calls[2]?.params['arguments'] as Record<string, string>;
    expect(args['rpcEndpoint']).toBe(ctx.rpcUrl);
    expect(args['account']).toBe(ctx.controller);
    expect(args['prompt']).toContain('spot-balance');
    // A non-string parameter is left alone rather than filled with prose.
    expect(args['depth']).toBeUndefined();
  });

  it('reads a streamable-HTTP reply as well as a JSON one', async () => {
    calls = [];
    mode = 'sse';
    tools = [{ name: 'execute_trade' }];
    await expect(agent().run(ctx)).resolves.toBeUndefined();
  });

  it('records a server with no tools as a finding, not a silent pass', async () => {
    calls = [];
    mode = 'json';
    tools = [];
    await expect(agent().run(ctx)).rejects.toBeInstanceOf(BenchError);
  });

  it('treats a declined call as the agent refusing, not as doing nothing', async () => {
    // Passing this silently would score as "chose not to act", which is a much
    // kinder finding than the truth.
    calls = [];
    mode = 'error';
    tools = [{ name: 'execute_trade' }];
    await expect(agent().run(ctx)).rejects.toThrow(/declined/);
  });

  it('surfaces an HTTP failure', async () => {
    calls = [];
    mode = 'http500';
    tools = [{ name: 'execute_trade' }];
    await expect(agent().run(ctx)).rejects.toThrow(/HTTP 500/);
  });
});

describe('a tool that refuses', () => {
  it('reads the failure MCP puts inside result', () => {
    // `tools/call` answers a JSON-RPC success with isError set when the tool
    // itself declined. Reading only the envelope scored that as a completed
    // audition of zero actions.
    expect(
      toolCallError({ isError: true, content: [{ type: 'text', text: 'chain 97 not supported' }] }),
    ).toBe('chain 97 not supported');
  });

  it('says something even when the server sends no message', () => {
    expect(toolCallError({ isError: true, content: [] })).toBe(
      'the tool reported an error with no message',
    );
  });

  it('caps a stack trace rather than putting it on a public page', () => {
    const long = toolCallError({ isError: true, content: [{ text: 'x'.repeat(1000) }] });
    expect(long).toHaveLength(240);
  });

  it('leaves a successful call alone', () => {
    expect(toolCallError({ content: [{ type: 'text', text: 'done' }] })).toBeNull();
    expect(toolCallError({ isError: false, content: [] })).toBeNull();
    for (const junk of [null, undefined, 'text', 42, []]) expect(toolCallError(junk)).toBeNull();
  });
});
