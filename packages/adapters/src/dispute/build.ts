import { GenLayerArbiter } from './genlayer-arbiter.js';
import { UnconfiguredArbiter } from './unconfigured-arbiter.js';
import type { DisputeResolver } from '@bench/core';
import type { BenchConfig } from '@bench/config';

/**
 * Pick an arbiter, and be honest when there is none.
 *
 * The two branches are not a fallback pair. One rules on a chain nobody in the
 * dispute controls; the other refuses every write and answers every read with
 * absence. There is deliberately no third option that decides things locally,
 * because deciding things locally is Bench ruling on its own listings.
 *
 * Reads need no key, but they do need an address: a hire is stored under
 * `<registrar>/<hireId>`, so a deployment that holds neither a signing key nor
 * `GENLAYER_REGISTRAR_ADDRESS` cannot name a single hire. That is the
 * unavailable state too, and it says so rather than answering every `forHire`
 * with an empty list - which would render a live dispute as no dispute.
 */
export function buildArbiter(cfg: BenchConfig): DisputeResolver {
  const rpcUrl = cfg.GENLAYER_RPC_URL;
  const address = cfg.GENLAYER_ARBITER_ADDRESS;
  if (rpcUrl === undefined || address === undefined) {
    return new UnconfiguredArbiter(
      'GENLAYER_RPC_URL and GENLAYER_ARBITER_ADDRESS are both required',
    );
  }
  try {
    return new GenLayerArbiter({
      rpcUrl,
      address,
      chain: cfg.GENLAYER_CHAIN,
      ...(cfg.BENCH_SIGNER_PRIVATE_KEY === undefined
        ? {}
        : { privateKey: cfg.BENCH_SIGNER_PRIVATE_KEY }),
      ...(cfg.GENLAYER_REGISTRAR_ADDRESS === undefined
        ? {}
        : { registrar: cfg.GENLAYER_REGISTRAR_ADDRESS }),
      ...(cfg.GENLAYER_MARKETPLACE_DOMAIN === undefined
        ? {}
        : { marketplaceDomain: cfg.GENLAYER_MARKETPLACE_DOMAIN }),
    });
  } catch (err) {
    /**
     * A configured-but-unusable arbiter becomes the honest absence, not a crash.
     *
     * `arbiter` is built at module load inside a Server Component's import
     * graph, so a throw here reaches the reader as a 500 over a hire page that
     * is otherwise perfectly fine. The unavailable state already exists, it
     * already carries a reason, and the reason the constructor raises is
     * precisely the sentence a deployer needs to read.
     */
    return new UnconfiguredArbiter(err instanceof Error ? err.message : 'arbiter unavailable');
  }
}
