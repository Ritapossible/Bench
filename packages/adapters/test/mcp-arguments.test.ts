import { describe, expect, it } from 'vitest';
import type { ShadowAgentContext } from '@bench/core';
import { McpShadowAgent } from '../src/agent/mcp-shadow-agent.js';

/**
 * What Bench puts in a stranger's tool call.
 *
 * Driven through the real driver rather than by exporting the helper, because
 * the bug this pins down was not in the mapping - there was no mapping. Every
 * string property got the audition prose, so SwapGod's
 * `swap_quote(token_in, token_out, amount_in)` received three copies of a
 * paragraph, answered "Unknown tool or invalid arguments", and was published
 * as "could not be driven".
 */
const TOKEN = `0x${'22'.repeat(20)}` as const;
const WBNB = `0x${'33'.repeat(20)}`;

const ctx = (params: Record<string, string | number | bigint> = {}): ShadowAgentContext => ({
  rpcUrl: 'https://fork.example/rpc/abc',
  controller: `0x${'11'.repeat(20)}`,
  controllerKey: `0x${'ab'.repeat(32)}`,
  window: {
    id: 'w-1',
    label: 'Recent market',
    regime: 'live',
    forkBlock: 1n,
    endBlock: 2n,
    seed: 's',
  },
  position: {
    kind: 'spot-balance',
    label: '10,000 USDT and 50 BNB',
    params,
    capital: { token: TOKEN, symbol: 'USDT', decimals: 18, amount: 10_000n * 10n ** 18n },
  },
  fetch: (async () => new Response('{}')) as never,
});

/** Capture the `tools/call` arguments the driver sends. */
async function callArgs(
  tool: Record<string, unknown>,
  context = ctx(),
): Promise<Record<string, unknown>> {
  let sent: Record<string, unknown> = {};
  const impl = (async (_url: string, opts?: { body?: string }) => {
    const req = JSON.parse(opts?.body ?? '{}') as {
      id?: unknown;
      method?: string;
      params?: { arguments?: Record<string, unknown> };
    };
    const result =
      req.method === 'initialize'
        ? {
            protocolVersion: '2025-06-18',
            capabilities: {},
            serverInfo: { name: 'x', version: '1' },
          }
        : req.method === 'tools/list'
          ? { tools: [tool] }
          : ((sent = req.params?.arguments ?? {}), { content: [{ type: 'text', text: 'ok' }] });
    return {
      status: 200,
      body: JSON.stringify({ jsonrpc: '2.0', id: req.id, result }),
      headers: new Headers({ 'content-type': 'application/json' }),
      truncated: false,
      latencyMs: 1,
    };
  }) as never;

  const agent = new McpShadowAgent({
    id: { chain: 'bsc-mainnet', tokenId: 1n },
    name: 'tool server',
    endpoint: { protocol: 'mcp', url: 'https://agent.example/mcp' },
    fetchImpl: impl,
  });
  await agent.run(context);
  return sent;
}

describe('MCP tool arguments', () => {
  it('answers a schema that means something with the position, not with prose', async () => {
    const args = await callArgs({
      name: 'swap_quote',
      inputSchema: {
        type: 'object',
        required: ['token_in', 'token_out', 'amount_in'],
        properties: {
          token_in: { type: 'string' },
          token_out: { type: 'string' },
          amount_in: { type: 'string' },
          slippage_bps: { type: 'integer', minimum: 0, maximum: 5000 },
        },
        additionalProperties: false,
      },
    });

    expect(args['token_in']).toBe(TOKEN);
    expect(args['amount_in']).toBe('10000');
    expect(args['slippage_bps']).toBe(100);
    // The thing that broke it: no argument carries the audition paragraph.
    for (const v of Object.values(args)) {
      expect(String(v)).not.toContain('You are being evaluated');
    }
  });

  it('uses the counter-asset the position names', async () => {
    const args = await callArgs(
      {
        name: 'swap_quote',
        inputSchema: { type: 'object', properties: { token_out: { type: 'string' } } },
      },
      ctx({ token1: WBNB }),
    );
    expect(args['token_out']).toBe(WBNB);
  });

  it('still hands prose to a tool that only takes prose', async () => {
    const args = await callArgs({
      name: 'ask',
      inputSchema: { type: 'object', properties: { question: { type: 'string' } } },
    });
    expect(String(args['question'])).toContain('You are being evaluated');
  });

  it('fills a required argument it has no fact for, so the call is well-formed', async () => {
    const args = await callArgs({
      name: 'quote',
      inputSchema: {
        type: 'object',
        required: ['account', 'mode'],
        properties: {
          account: { type: 'string' },
          mode: { type: 'string', enum: ['fast', 'cheap'] },
          optional_flag: { type: 'boolean' },
        },
      },
    });
    expect(args['mode']).toBe('fast');
    expect('optional_flag' in args).toBe(false);
  });

  it('does not answer a private-key argument with the address', async () => {
    const args = await callArgs({
      name: 'trade',
      inputSchema: {
        type: 'object',
        properties: { account: { type: 'string' }, accountPrivateKey: { type: 'string' } },
      },
    });
    expect(args['account']).toBe(`0x${'11'.repeat(20)}`);
    expect(args['accountPrivateKey']).toBe(`0x${'ab'.repeat(32)}`);
  });
});
