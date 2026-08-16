import { createHash } from 'node:crypto';
import type { ProbeResult } from './types/agent.js';
import type { AuditionWindow } from './types/audition.js';
import type { Hex } from './types/primitives.js';

/**
 * Deterministic commitments. Two things in Bench are published as claims about
 * our own data — the liveness record and the audition record — and both are
 * worth nothing unless a third party can recompute them. These functions are
 * the recomputable part, so they are pure, total, and dependency-free.
 *
 * SHA-256 rather than keccak so this module stays free of any chain library;
 * @bench/core must never import one. The output is 32 bytes either way, which
 * is what the registry write needs.
 */

const sha256 = (s: string): Hex =>
  `0x${createHash('sha256').update(s, 'utf8').digest('hex')}` as Hex;

export const ZERO_DIGEST: Hex = `0x${'00'.repeat(32)}` as Hex;

/**
 * Canonical string form of one probe. Field order is fixed and every field is
 * length-delimited, so no combination of values can be encoded two ways —
 * without that, a URL containing the separator could forge a different record
 * that hashes the same.
 */
function encodeProbe(p: ProbeResult): string {
  const parts = [
    p.agent.chain,
    p.agent.tokenId.toString(),
    p.endpoint.protocol,
    p.endpoint.url,
    p.at.toISOString(),
    p.reachable ? '1' : '0',
    p.latencyMs === null ? '-' : String(p.latencyMs),
    p.conformant ? '1' : '0',
  ];
  return parts.map((f) => `${f.length}:${f}`).join('|');
}

/** Stable ordering so two indexers with different read orders agree. */
function canonicalOrder(probes: readonly ProbeResult[]): readonly ProbeResult[] {
  return [...probes].sort((a, b) => {
    if (a.agent.chain !== b.agent.chain) return a.agent.chain < b.agent.chain ? -1 : 1;
    if (a.agent.tokenId !== b.agent.tokenId) return a.agent.tokenId < b.agent.tokenId ? -1 : 1;
    if (a.endpoint.url !== b.endpoint.url) return a.endpoint.url < b.endpoint.url ? -1 : 1;
    return a.at.getTime() - b.at.getTime();
  });
}

/** Commitment over one batch of probe results. */
export function probeDigest(probes: readonly ProbeResult[]): Hex {
  return sha256(canonicalOrder(probes).map(encodeProbe).join('\n'));
}

/**
 * Roll a batch into the previous anchor, producing a hash chain rather than a
 * sequence of independent digests. Chaining is what makes the liveness record
 * tamper-evident: rewriting any historical batch invalidates every anchor
 * after it, and those are onchain.
 */
export function rollProbeDigest(previous: Hex, probes: readonly ProbeResult[]): Hex {
  return sha256(`${previous}${probeDigest(probes)}`);
}

/**
 * Commitment over the parameters needed to re-run an audition: fork block,
 * end block, and seed. Published with every outcome record so anyone can
 * replay the audition and check Bench's arithmetic — the difference between a
 * verifiable record and a number Bench asserts.
 *
 * Deliberately excludes results. It commits to the *setup*, so it can be
 * computed before the run and compared after.
 */
export function replayHash(window: AuditionWindow): Hex {
  const parts = [
    window.id,
    window.regime,
    window.forkBlock.toString(),
    window.endBlock.toString(),
    window.seed,
  ];
  return sha256(parts.map((f) => `${f.length}:${f}`).join('|'));
}
