import 'server-only';
import { buildArbiter, UnconfiguredArbiter } from '@bench/adapters';
import { loadConfig } from '@bench/config';
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

function build(): DisputeResolver {
  try {
    return buildArbiter(loadConfig(process.env));
  } catch (err) {
    /**
     * A malformed config costs the dispute panel, not the whole app - but it
     * must not cost the explanation too.
     *
     * `loadConfig` validates the *entire* environment, so a missing variable
     * with nothing to do with disputes takes the arbiter down with it. This
     * used to fall through to `buildArbiter({})`, whose refusal reads "set
     * GENLAYER_RPC_URL and GENLAYER_ARBITER_ADDRESS" - and when those are
     * already set, that sentence sends whoever reads it to look in precisely
     * the wrong place. It cost an afternoon to find from the outside.
     *
     * Redacted on the way through: the message names variables rather than
     * values, and a config error is exactly the kind of thing that ends up
     * quoting one.
     */
    return new UnconfiguredArbiter(
      redactSecrets(err instanceof Error ? err.message : String(err), 400),
    );
  }
}

export const arbiter: DisputeResolver = build();

/** True when disputes on this deployment are ruled on by someone other than Bench. */
export const disputesAdjudicated = arbiter.available;
