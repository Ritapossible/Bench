import 'server-only';
import { buildArbiter } from '@bench/adapters';
import { loadConfig } from '@bench/config';
import type { DisputeResolver } from '@bench/core';

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
  } catch {
    // A malformed config should cost the dispute panel, not the whole app. The
    // hire page has plenty to render without it, and the panel's unavailable
    // state is already a thing this UI knows how to say.
    return buildArbiter({} as ReturnType<typeof loadConfig>);
  }
}

export const arbiter: DisputeResolver = build();

/** True when disputes on this deployment are ruled on by someone other than Bench. */
export const disputesAdjudicated = arbiter.available;
