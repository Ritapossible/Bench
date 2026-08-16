import { describe, expect, it } from 'vitest';
import {
  ZERO_DIGEST,
  probeDigest,
  replayHash,
  rollProbeDigest,
  type AgentId,
  type AuditionWindow,
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

/**
 * Bench publishes two claims about its own data — the liveness record and the
 * audition record — and both are worthless unless a third party can recompute
 * them. These tests are about that recomputability.
 */
describe('probeDigest', () => {
  it('is independent of input order', () => {
    // Postgres and the in-memory repo return probes in different orders. If
    // the digest depended on that, two honest indexers would disagree and the
    // onchain anchor would prove nothing.
    const a = probe();
    const b = probe({ agent: { chain: 'bsc-testnet', tokenId: 2n } });
    expect(probeDigest([a, b])).toBe(probeDigest([b, a]));
  });

  it('changes when any field changes', () => {
    const base = probeDigest([probe()]);
    expect(probeDigest([probe({ reachable: false })])).not.toBe(base);
    expect(probeDigest([probe({ conformant: false })])).not.toBe(base);
    expect(probeDigest([probe({ latencyMs: 101 })])).not.toBe(base);
    expect(probeDigest([probe({ at: new Date('2026-08-16T12:00:01Z') })])).not.toBe(base);
  });

  it('cannot be forged by embedding the field separator in a URL', () => {
    // The reason every field is length-prefixed. With naive joining, a URL
    // containing the delimiter could produce the same bytes as a different
    // record — letting someone claim a probe result they never received.
    const sneaky = probe({ endpoint: { protocol: 'a2a', url: 'https://a|1:b' } });
    const plain = probe({ endpoint: { protocol: 'a2a', url: 'https://a' } });
    expect(probeDigest([sneaky])).not.toBe(probeDigest([plain]));
  });

  it('produces a 32-byte hex value, the width the registry write needs', () => {
    expect(probeDigest([probe()])).toMatch(/^0x[0-9a-f]{64}$/);
    expect(ZERO_DIGEST).toMatch(/^0x0{64}$/);
  });
});

describe('rollProbeDigest', () => {
  it('chains, so rewriting history invalidates every later anchor', () => {
    const batch = [probe()];
    const fromZero = rollProbeDigest(ZERO_DIGEST, batch);
    const fromOther = rollProbeDigest(probeDigest(batch), batch);
    expect(fromZero).not.toBe(fromOther);
  });

  it('is stable for identical inputs', () => {
    const batch = [probe()];
    expect(rollProbeDigest(ZERO_DIGEST, batch)).toBe(rollProbeDigest(ZERO_DIGEST, batch));
  });
});

describe('replayHash', () => {
  const window: AuditionWindow = {
    id: 'w1',
    label: 'PCS LP crash',
    regime: 'crash',
    forkBlock: 44_000_000n,
    endBlock: 44_010_000n,
    seed: 'seed-1',
  };

  it('commits to the setup so an audition can be independently re-run', () => {
    expect(replayHash(window)).toBe(replayHash({ ...window }));
  });

  it('distinguishes every parameter that changes the run', () => {
    const base = replayHash(window);
    expect(replayHash({ ...window, seed: 'seed-2' })).not.toBe(base);
    expect(replayHash({ ...window, forkBlock: 44_000_001n })).not.toBe(base);
    expect(replayHash({ ...window, endBlock: 44_010_001n })).not.toBe(base);
  });

  it('ignores the human label, which does not affect the run', () => {
    expect(replayHash({ ...window, label: 'renamed' })).toBe(replayHash(window));
  });
});
