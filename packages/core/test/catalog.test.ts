import { describe, expect, it } from 'vitest';
import {
  VERIFIED_LIVE,
  isVerifiedLive,
  liveShareBps,
  summarizeProbes,
  type AgentId,
  type LivenessSummary,
  type ProbeResult,
} from '../src/index.js';

const agent: AgentId = { chain: 'bsc-testnet', tokenId: 1n };
const endpoint = { protocol: 'a2a' as const, url: 'https://agent.example.com/a2a' };

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  agent,
  endpoint,
  at: new Date('2026-08-16T12:00:00Z'),
  reachable: true,
  latencyMs: 100,
  conformant: true,
  ...over,
});

const summary = (over: Partial<LivenessSummary> = {}): LivenessSummary => ({
  agent,
  lastProbedAt: new Date('2026-08-16T12:00:00Z'),
  reachable: true,
  conformant: true,
  uptimeBps: 10_000,
  p95LatencyMs: 100,
  probeCount: 10,
  ...over,
});

const now = new Date('2026-08-16T12:30:00Z');

/**
 * The verified-live filter is the single most load-bearing claim in Phase 1:
 * it is what turns a registry dump into a catalog, and Bench publishes the
 * resulting density figure. These cases pin the definition down.
 */
describe('isVerifiedLive', () => {
  it('accepts a healthy, recently probed, conformant agent', () => {
    expect(isVerifiedLive(summary(), now)).toBe(true);
  });

  it('rejects an endpoint that answers but does not speak its protocol', () => {
    // The whole point of the filter. A parked domain returning 200 is a live
    // web server, not a live agent, and counting it would rebuild the empty
    // directory Bench exists to replace.
    expect(isVerifiedLive(summary({ conformant: false }), now)).toBe(false);
  });

  it('rejects an agent whose most recent probe failed', () => {
    expect(isVerifiedLive(summary({ reachable: false }), now)).toBe(false);
  });

  it('rejects a never-probed agent rather than assuming the best', () => {
    expect(isVerifiedLive(summary({ lastProbedAt: null, probeCount: 0 }), now)).toBe(false);
  });

  it('expires a stale probe — liveness is a claim about now', () => {
    const stale = new Date(now.getTime() - VERIFIED_LIVE.maxProbeAgeMs - 1000);
    expect(isVerifiedLive(summary({ lastProbedAt: stale }), now)).toBe(false);
  });

  it('rejects a flapping endpoint even when the latest probe passed', () => {
    expect(isVerifiedLive(summary({ uptimeBps: VERIFIED_LIVE.minUptimeBps - 1 }), now)).toBe(false);
  });

  it('does not call a single lucky response a track record', () => {
    expect(isVerifiedLive(summary({ probeCount: 1 }), now)).toBe(false);
    expect(isVerifiedLive(summary({ probeCount: VERIFIED_LIVE.minProbeCount }), now)).toBe(true);
  });
});

describe('summarizeProbes', () => {
  it('reports a never-probed agent as not live rather than unknown', () => {
    const s = summarizeProbes(agent, []);
    expect(s).toMatchObject({ reachable: false, conformant: false, probeCount: 0, uptimeBps: 0 });
    expect(s.lastProbedAt).toBeNull();
    expect(isVerifiedLive(s, now)).toBe(false);
  });

  it('takes reachable/conformant from the newest probe regardless of input order', () => {
    const older = probe({ at: new Date('2026-08-16T10:00:00Z'), reachable: false, conformant: false });
    const newer = probe({ at: new Date('2026-08-16T11:00:00Z'), reachable: true, conformant: true });
    // Fed newest-first, which is how Postgres returns it.
    const s = summarizeProbes(agent, [newer, older]);
    expect(s.reachable).toBe(true);
    expect(s.conformant).toBe(true);
    expect(s.lastProbedAt).toEqual(newer.at);
  });

  it('computes uptime as the share of reachable probes', () => {
    const probes = [
      probe({ at: new Date('2026-08-16T09:00:00Z'), reachable: false }),
      probe({ at: new Date('2026-08-16T10:00:00Z') }),
      probe({ at: new Date('2026-08-16T11:00:00Z') }),
      probe({ at: new Date('2026-08-16T12:00:00Z') }),
    ];
    expect(summarizeProbes(agent, probes).uptimeBps).toBe(7500);
  });

  it('excludes failed probes from p95 so fast failure cannot beat slow success', () => {
    // Without this, an endpoint that refuses connections in 1ms would report
    // better latency than one that actually serves requests in 200ms.
    const probes = [
      probe({ at: new Date('2026-08-16T09:00:00Z'), reachable: false, latencyMs: 1 }),
      probe({ at: new Date('2026-08-16T10:00:00Z'), latencyMs: 200 }),
      probe({ at: new Date('2026-08-16T11:00:00Z'), latencyMs: 210 }),
    ];
    expect(summarizeProbes(agent, probes).p95LatencyMs).toBe(210);
  });

  it('returns null p95 when nothing ever succeeded', () => {
    const probes = [probe({ reachable: false, latencyMs: null })];
    expect(summarizeProbes(agent, probes).p95LatencyMs).toBeNull();
  });
});

describe('liveShareBps', () => {
  it('measures catalog density instead of asserting the headline number', () => {
    const stats = {
      chain: 'bsc-testnet' as const,
      registered: 1000,
      withResolvableCard: 120,
      verifiedLive: 40,
      computedAt: now,
    };
    expect(liveShareBps(stats)).toBe(400); // 4%
  });

  it('does not divide by zero on an empty catalog', () => {
    expect(
      liveShareBps({
        chain: 'bsc-testnet',
        registered: 0,
        withResolvableCard: 0,
        verifiedLive: 0,
        computedAt: now,
      }),
    ).toBe(0);
  });
});
