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
 * Reads work without a key. A deployment that displays disputes but cannot file
 * them is a coherent thing to be and should not have to hold a funded GenLayer
 * account to render a page.
 */
export function buildArbiter(cfg: BenchConfig): DisputeResolver {
  if (cfg.GENLAYER_RPC_URL === undefined || cfg.GENLAYER_ARBITER_ADDRESS === undefined) {
    return new UnconfiguredArbiter(
      'GENLAYER_RPC_URL and GENLAYER_ARBITER_ADDRESS are both required',
    );
  }
  return new GenLayerArbiter({
    rpcUrl: cfg.GENLAYER_RPC_URL,
    address: cfg.GENLAYER_ARBITER_ADDRESS,
    ...(cfg.BENCH_SIGNER_PRIVATE_KEY === undefined
      ? {}
      : { privateKey: cfg.BENCH_SIGNER_PRIVATE_KEY }),
    ...(cfg.GENLAYER_MARKETPLACE_DOMAIN === undefined
      ? {}
      : { marketplaceDomain: cfg.GENLAYER_MARKETPLACE_DOMAIN }),
  });
}
