import { GenLayerArbiter } from './genlayer-arbiter.js';
import { UnconfiguredArbiter } from './unconfigured-arbiter.js';
import type { DisputeResolver } from '@bench/core';
import type { BenchConfig } from '@bench/config';

/**
 * Only what an arbiter actually needs.
 *
 * **Not the whole `BenchConfig`, and that distinction turned out to matter.**
 * `loadConfig` validates the entire environment, so building the arbiter
 * through it made the dispute layer depend on variables it never reads -
 * `REDIS_URL`, the BSC RPC, the identity registry - all of which belong to the
 * worker. On a split deployment the web app has no reason to hold any of them,
 * so the arbiter went dark in production and reported three missing worker
 * variables as the cause. They were missing. They were also irrelevant.
 *
 * A component should fail for its own reasons. This is the set of them.
 */
export type ArbiterEnv = Pick<
  BenchConfig,
  | 'GENLAYER_RPC_URL'
  | 'GENLAYER_ARBITER_ADDRESS'
  | 'GENLAYER_CHAIN'
  | 'GENLAYER_SIGNER_PRIVATE_KEY'
  | 'GENLAYER_REGISTRAR_ADDRESS'
  | 'GENLAYER_MARKETPLACE_DOMAIN'
>;

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
export function buildArbiter(cfg: ArbiterEnv): DisputeResolver {
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
      /**
       * The arbiter's own key, never Bench's BSC signer.
       *
       * `BENCH_SIGNER_PRIVATE_KEY` holds real BNB and anchors probe digests to
       * the ERC-8004 Validation Registry; the same secp256k1 key is the same
       * address on GenLayer, so reusing it would put Bench's anchoring
       * authority behind a devnet gas key. There is no fallback on purpose -
       * see the config comment.
       */
      ...(cfg.GENLAYER_SIGNER_PRIVATE_KEY === undefined
        ? {}
        : { privateKey: cfg.GENLAYER_SIGNER_PRIVATE_KEY }),
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
