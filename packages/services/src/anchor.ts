import {
  ZERO_DIGEST,
  rollProbeDigest,
  type CatalogRepository,
  type Hex,
  type RegistryClient,
} from '@bench/core';

/**
 * Anchors the rolling probe digest onchain.
 *
 * Without this, Bench's liveness record is a claim Bench makes about itself:
 * we say an agent was reachable last Tuesday and the only evidence is our own
 * database, which we can rewrite. Anchoring turns it into a commitment made at
 * a time we cannot backdate.
 *
 * The digest is a hash *chain*, not a series of independent hashes — each
 * anchor folds in the previous one — so altering any historical probe batch
 * invalidates every anchor after it. Tampering therefore requires rewriting
 * onchain history rather than a database row.
 */

export interface AnchorOptions {
  /** Probes per anchor. Too small wastes gas; too large widens the gap. */
  readonly batchSize?: number;
  /** Skip anchoring below this many probes, unless forced. */
  readonly minBatch?: number;
}

export type AnchorTickResult =
  | { readonly anchored: false; readonly pending: number }
  | {
      readonly anchored: true;
      readonly pending: number;
      readonly digest: Hex;
      readonly txHash: Hex;
      readonly probeCount: number;
    };

const DEFAULTS = { batchSize: 500, minBatch: 25 } as const;

export class ProbeAnchor {
  constructor(
    private readonly registry: RegistryClient,
    private readonly repo: CatalogRepository,
    private readonly opts: AnchorOptions = {},
  ) {}

  async tick(force = false): Promise<AnchorTickResult> {
    const batch = await this.repo.unanchoredProbes(this.opts.batchSize ?? DEFAULTS.batchSize);
    const minBatch = this.opts.minBatch ?? DEFAULTS.minBatch;

    if (batch.length === 0 || (!force && batch.length < minBatch)) {
      return { anchored: false, pending: batch.length };
    }

    const previous = (await this.repo.lastAnchoredDigest()) ?? ZERO_DIGEST;
    const digest = rollProbeDigest(previous, batch);

    // Send first, mark second. The reverse order would mark probes anchored
    // against a transaction that never landed, and the chain would then be
    // unverifiable at exactly the point it is supposed to prove something.
    const txHash = await this.registry.anchorProbeDigest(digest);

    const latest = batch.reduce((max, p) => (p.at > max ? p.at : max), batch[0]!.at);
    await this.repo.markProbesAnchored(latest, digest, txHash);

    return { anchored: true, pending: 0, digest, txHash, probeCount: batch.length };
  }
}
