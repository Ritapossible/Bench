import {
  ZERO_DIGEST,
  rollProbeDigest,
  type AgentId,
  type CatalogRepository,
  type Hex,
  type ProbeResult,
  type RegistryClient,
} from '@bench/core';
import { describe, expect, it } from 'vitest';
import { ProbeAnchor } from '../src/anchor.js';

/**
 * Anchoring is what turns Bench's liveness record from "trust our database"
 * into a commitment we cannot backdate. The chaining property is the point: it
 * makes tampering require rewriting onchain history rather than a table row.
 */

const agent: AgentId = { chain: 'bsc-testnet', tokenId: 1n };
const endpoint = { protocol: 'a2a' as const, url: 'https://a.example/a2a' };

const probe = (iso: string): ProbeResult => ({
  agent,
  endpoint,
  at: new Date(iso),
  reachable: true,
  latencyMs: 10,
  conformant: true,
});

class StubRegistry implements Partial<RegistryClient> {
  readonly anchored: Hex[] = [];
  shouldFail = false;

  async anchorProbeDigest(digest: Hex): Promise<Hex> {
    if (this.shouldFail) throw new Error('tx reverted');
    this.anchored.push(digest);
    return `0x${'22'.repeat(32)}`;
  }
}

class StubRepo implements Partial<CatalogRepository> {
  probes: ProbeResult[] = [];
  readonly marks: { upTo: Date; digest: Hex }[] = [];

  async unanchoredProbes(limit: number): Promise<readonly ProbeResult[]> {
    const cutoff = this.marks.at(-1)?.upTo ?? null;
    return this.probes.filter((p) => cutoff === null || p.at > cutoff).slice(0, limit);
  }
  async markProbesAnchored(upTo: Date, digest: Hex): Promise<number> {
    this.marks.push({ upTo, digest });
    return 1;
  }
  async lastAnchoredDigest(): Promise<Hex | null> {
    return this.marks.at(-1)?.digest ?? null;
  }
}

const build = (registry: StubRegistry, repo: StubRepo, over = {}) =>
  new ProbeAnchor(registry as unknown as RegistryClient, repo as unknown as CatalogRepository, {
    minBatch: 1,
    ...over,
  });

describe('ProbeAnchor', () => {
  it('holds below the minimum batch rather than spending gas', async () => {
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z')];
    const registry = new StubRegistry();

    const r = await build(registry, repo, { minBatch: 5 }).tick();

    expect(r.anchored).toBe(false);
    expect(registry.anchored).toHaveLength(0);
  });

  it('anchors from the zero digest on the very first batch', async () => {
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z'), probe('2026-08-16T11:00:00Z')];
    const registry = new StubRegistry();

    const r = await build(registry, repo).tick();

    expect(r.anchored).toBe(true);
    if (r.anchored) {
      expect(r.digest).toBe(rollProbeDigest(ZERO_DIGEST, repo.probes));
      expect(r.probeCount).toBe(2);
    }
  });

  it('chains each anchor onto the previous one', async () => {
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z')];
    const registry = new StubRegistry();
    const anchor = build(registry, repo);

    const first = await anchor.tick();
    repo.probes.push(probe('2026-08-16T11:00:00Z'));
    const second = await anchor.tick();

    expect(first.anchored && second.anchored).toBe(true);
    if (first.anchored && second.anchored) {
      expect(second.digest).not.toBe(first.digest);
    }
    expect(registry.anchored).toHaveLength(2);
  });

  it('marks probes anchored only after the transaction lands', async () => {
    // Marking first would leave the database claiming a commitment that does
    // not exist onchain — unverifiable exactly where it must prove something.
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z')];
    const registry = new StubRegistry();
    registry.shouldFail = true;

    await expect(build(registry, repo).tick()).rejects.toThrow(/tx reverted/);
    expect(repo.marks).toHaveLength(0);
  });

  it('covers up to the newest probe in the batch', async () => {
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z'), probe('2026-08-16T12:00:00Z')];

    await build(new StubRegistry(), repo).tick();

    expect(repo.marks[0]?.upTo).toEqual(new Date('2026-08-16T12:00:00Z'));
  });

  it('force anchors a small batch when asked', async () => {
    const repo = new StubRepo();
    repo.probes = [probe('2026-08-16T10:00:00Z')];

    const r = await build(new StubRegistry(), repo, { minBatch: 99 }).tick(true);

    expect(r.anchored).toBe(true);
  });

  it('reports nothing pending on an empty queue', async () => {
    const r = await build(new StubRegistry(), new StubRepo()).tick();
    expect(r).toEqual({ anchored: false, pending: 0 });
  });
});
