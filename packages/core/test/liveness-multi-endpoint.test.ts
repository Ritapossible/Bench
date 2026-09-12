import { describe, expect, it } from 'vitest';
import {
  isVerifiedLive,
  summarizeProbes,
  type AgentId,
  type AgentEndpoint,
  type ProbeResult,
} from '../src/index.js';

/**
 * Agents that publish more than one address are not a corner case here.
 * Sampling the oldest 28,000 mainnet registrations, 7 of the 19 that declared
 * any callable endpoint declared several - and ClawdMint, the first agent to
 * reach an audition, has a working MCP service behind a broken A2A card.
 */
const agent: AgentId = { chain: 'bsc-mainnet', tokenId: 2468n };
const a2a: AgentEndpoint = {
  protocol: 'a2a',
  url: 'https://x.example/.well-known/agent-card.json',
};
const mcp: AgentEndpoint = { protocol: 'mcp', url: 'https://api.x.example/mcp' };

const probe = (
  endpoint: AgentEndpoint,
  at: string,
  reachable: boolean,
  conformant: boolean,
): ProbeResult => ({
  agent,
  endpoint,
  at: new Date(at),
  reachable,
  latencyMs: reachable ? 100 : null,
  conformant,
  ...(reachable ? {} : { error: 'dead' }),
});

const now = new Date('2026-09-12T12:00:00Z');

describe('liveness across several endpoints', () => {
  /** A working MCP service and a 404ing A2A card, three probes each. */
  const clawdmint: ProbeResult[] = [
    probe(mcp, '2026-09-12T11:40:00Z', true, true),
    probe(mcp, '2026-09-12T11:45:00Z', true, true),
    probe(mcp, '2026-09-12T11:50:00Z', true, true),
    probe(a2a, '2026-09-12T11:42:00Z', true, false),
    probe(a2a, '2026-09-12T11:47:00Z', true, false),
    // The most recent probe of all, and it is the broken address.
    probe(a2a, '2026-09-12T11:55:00Z', true, false),
  ];

  it('is conformant on its best address, not on whichever was probed last', () => {
    // Pooled, `conformant` was the latest probe's verdict - a coin flip
    // re-tossed every few minutes.
    expect(summarizeProbes(agent, clawdmint).conformant).toBe(true);
  });

  it('is verified live, which pooling made impossible', () => {
    expect(isVerifiedLive(summarizeProbes(agent, clawdmint), now)).toBe(true);
  });

  it('does not let a dead endpoint drag uptime below the floor', () => {
    // One live endpoint and one entirely dead one pooled to ~50% uptime,
    // permanently below the 80% isVerifiedLive requires - so the agent could
    // never qualify however perfect its working service was.
    const mixed = [
      probe(mcp, '2026-09-12T11:40:00Z', true, true),
      probe(mcp, '2026-09-12T11:45:00Z', true, true),
      probe(mcp, '2026-09-12T11:50:00Z', true, true),
      probe(a2a, '2026-09-12T11:41:00Z', false, false),
      probe(a2a, '2026-09-12T11:46:00Z', false, false),
      probe(a2a, '2026-09-12T11:51:00Z', false, false),
    ];
    const s = summarizeProbes(agent, mixed);
    expect(s.uptimeBps).toBe(10_000);
    expect(isVerifiedLive(s, now)).toBe(true);
  });

  it('counts probes per endpoint, so three addresses probed once each do not qualify', () => {
    const thin = [
      probe(mcp, '2026-09-12T11:40:00Z', true, true),
      probe(a2a, '2026-09-12T11:41:00Z', true, true),
      probe({ protocol: 'a2a', url: 'https://y.example/a2a' }, '2026-09-12T11:42:00Z', true, true),
    ];
    const s = summarizeProbes(agent, thin);
    expect(s.probeCount).toBe(1);
    expect(isVerifiedLive(s, now)).toBe(false);
  });

  it('still reports a dead agent as dead', () => {
    const dead = [
      probe(a2a, '2026-09-12T11:40:00Z', true, false),
      probe(a2a, '2026-09-12T11:45:00Z', true, false),
      probe(mcp, '2026-09-12T11:50:00Z', false, false),
    ];
    const s = summarizeProbes(agent, dead);
    expect(s.conformant).toBe(false);
    expect(isVerifiedLive(s, now)).toBe(false);
  });

  it('is unchanged for the single-endpoint agent, which is most of them', () => {
    const one = [
      probe(mcp, '2026-09-12T11:40:00Z', true, true),
      probe(mcp, '2026-09-12T11:45:00Z', false, false),
      probe(mcp, '2026-09-12T11:50:00Z', true, true),
    ];
    const s = summarizeProbes(agent, one);
    expect(s.probeCount).toBe(3);
    expect(s.uptimeBps).toBe(6667);
    expect(s.conformant).toBe(true);
    // 66.67% is below the 80% floor, so it is not live - as before.
    expect(isVerifiedLive(s, now)).toBe(false);
  });
});
