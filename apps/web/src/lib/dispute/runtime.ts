import 'server-only';
import { z } from 'zod';
import { buildArbiter, UnconfiguredArbiter, type ArbiterEnv } from '@bench/adapters';
import { redactSecrets, type DisputeResolver } from '@bench/core';

/**
 * The arbiter this deployment rules with, or an honest absence.
 *
 * Read once at module load rather than per request, for the same reason the
 * data layer is: a process that started without an arbiter should not silently
 * acquire one halfway through, and constructing a chain client per page render
 * would be worse than either.
 *
 * **A deployment with no arbiter renders as a deployment with no arbiter.** It
 * does not fall back to deciding disputes locally, because the local decider
 * would be Bench - which lists the agent, ranks it, and takes a cut of the hire
 * being disputed. `arbiter.available` is what the page branches on, and the
 * copy beside it says which of the two states a reader is looking at.
 */

/**
 * Parsed here, and only these.
 *
 * This used to call `loadConfig`, which validates the *entire* environment -
 * so the dispute layer inherited every requirement the worker has. In
 * production the web app has no `REDIS_URL`, no BSC RPC and no identity
 * registry, because it reads the database and the worker does the chain work.
 * The arbiter therefore went dark and reported three missing worker variables
 * as its reason: true, and nothing to do with disputes, which sent everyone
 * looking in the wrong place.
 *
 * A component that fails should fail for its own reasons. These six are the
 * arbiter's own, and nothing else can take it down now.
 */
const arbiterEnv = z.object({
  GENLAYER_RPC_URL: z.string().url().optional(),
  GENLAYER_ARBITER_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed address')
    .optional(),
  GENLAYER_CHAIN: z
    .enum([
      'localnet',
      'studionet',
      'studio-next',
      'studio-devnet',
      'testnet-bradbury',
      'testnet-asimov',
    ])
    .default('studio-next'),
  GENLAYER_SIGNER_PRIVATE_KEY: z.string().optional(),
  GENLAYER_REGISTRAR_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x-prefixed address')
    .optional(),
  GENLAYER_MARKETPLACE_DOMAIN: z.string().optional(),
});

function build(): DisputeResolver {
  const parsed = arbiterEnv.safeParse(process.env);
  if (!parsed.success) {
    /**
     * Still never a throw at module load.
     *
     * This module is imported by a Server Component, so raising here takes the
     * hire page down over a variable only the dispute panel reads. The panel
     * has an unavailable state that carries a reason, and the reason now names
     * the arbiter's own settings rather than someone else's.
     *
     * Redacted on the way through: a validation error is exactly the kind of
     * message that ends up quoting the value it rejected.
     */
    const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    return new UnconfiguredArbiter(redactSecrets(why, 400));
  }
  return buildArbiter(parsed.data as ArbiterEnv);
}

export const arbiter: DisputeResolver = build();

/** True when disputes on this deployment are ruled on by someone other than Bench. */
export const disputesAdjudicated = arbiter.available;
