import { describe, expect, it } from 'vitest';
import { BenchError, type ShadowAgent, type ShadowAgentContext } from '@bench/core';
import { FallbackShadowAgent } from '../src/agent/fallback-shadow-agent.js';

/**
 * Taken from ClawdMint, ERC-8004 token #2468 on BSC mainnet. It declares A2A
 * and MCP. The A2A registration points at an agent card whose `url` names the
 * agent's marketing site, where a POST returns 404; the MCP endpoint on the
 * same registration initializes and lists twelve tools. Picking A2A and giving
 * up published a working agent as undrivable.
 */
const ctx = {} as ShadowAgentContext;

const agent = (name: string, behaviour: () => void): ShadowAgent & { calls: number } => {
  const a = {
    id: 'a',
    name,
    calls: 0,
    async run(): Promise<void> {
      a.calls += 1;
      behaviour();
    },
  };
  return a;
};

const ok = (name: string) => agent(name, () => {});
const fails = (name: string, code: string, message = 'nope') =>
  agent(name, () => {
    throw new BenchError(code as ConstructorParameters<typeof BenchError>[0], message);
  });

describe('FallbackShadowAgent', () => {
  it('moves to the next transport when the first address is not usable', async () => {
    const a2a = fails('a2a', 'ENDPOINT_UNREACHABLE', 'agent returned HTTP 404');
    const mcp = ok('mcp');
    await new FallbackShadowAgent([a2a, mcp]).run(ctx);
    expect(a2a.calls).toBe(1);
    expect(mcp.calls).toBe(1);
  });

  it.each(['ENDPOINT_UNREACHABLE', 'UPSTREAM_UNAVAILABLE', 'INVALID_AGENT_CARD'])(
    'treats %s as a fact about one address, not about the agent',
    async (code) => {
      const mcp = ok('mcp');
      await new FallbackShadowAgent([fails('a2a', code), mcp]).run(ctx);
      expect(mcp.calls).toBe(1);
    },
  );

  it('stops at a decline rather than shopping for a kinder verdict', async () => {
    // The same agent sits behind every transport it publishes, so re-asking
    // over another one until something says yes is not a measurement.
    const mcp = ok('mcp');
    const declined = fails('a2a', 'PROTOCOL_NONCONFORMANT', 'agent declined: wrong position type');
    await expect(new FallbackShadowAgent([declined, mcp]).run(ctx)).rejects.toThrow('declined');
    expect(mcp.calls).toBe(0);
  });

  it('stops at our own failure, so a bug here is never sold as an agent result', async () => {
    const mcp = ok('mcp');
    await expect(
      new FallbackShadowAgent([fails('a2a', 'FORK_UNAVAILABLE', 'anvil died'), mcp]).run(ctx),
    ).rejects.toThrow('anvil died');
    expect(mcp.calls).toBe(0);
  });

  it('reports the first address when every transport is unusable', async () => {
    // The registration lists that one first, so it is the one whose failure a
    // reader - and the agent's owner - needs to see.
    await expect(
      new FallbackShadowAgent([
        fails('a2a', 'ENDPOINT_UNREACHABLE', 'HTTP 404 at the marketing site'),
        fails('mcp', 'ENDPOINT_UNREACHABLE', 'HTTP 500'),
      ]).run(ctx),
    ).rejects.toThrow('marketing site');
  });

  it('refuses to be constructed with nothing to drive', () => {
    expect(() => new FallbackShadowAgent([])).toThrow(BenchError);
  });

  it('takes its identity from the first transport', () => {
    expect(new FallbackShadowAgent([ok('a2a'), ok('mcp')]).name).toBe('a2a');
  });
});
