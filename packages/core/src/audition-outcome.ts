import { BenchError, type BenchErrorCode } from './types/primitives.js';

/**
 * ============================================================================
 * Why an audition produced nothing.
 * ============================================================================
 *
 * "Agents auditioned: 18" counted eighteen agents, of which one completed a
 * run, several declined in their own words and one was never addressable. Held
 * as a single number, those are indistinguishable - and each of them says
 * something different about the ecosystem Bench exists to measure:
 *
 *   completed    the agent took the task and finished. Its delta is a
 *                measurement, including when the delta is zero.
 *   declined     the agent answered and said no. A finding about the agent:
 *                wrong position type, an envelope it does not accept, a skill
 *                it does not have.
 *   unreachable  nothing usable came back. A finding about the registration:
 *                a card naming localhost, a host that does not resolve, a
 *                service that never answered.
 *   errored      Bench's own failure - a fork that would not start, a bug.
 *                Kept separate and named as ours, because every published
 *                number in this project was once one of these wearing one of
 *                the labels above.
 *
 * Derived from the error's code at the point it is caught, while the code is
 * still in hand. The alternative - reading it back out of the stored message -
 * is pattern-matching prose that this project rewrites regularly, and it would
 * silently reclassify history every time a sentence changed.
 */
export type AuditionOutcomeKind = 'completed' | 'declined' | 'unreachable' | 'errored';

const BY_CODE: Partial<Record<BenchErrorCode, AuditionOutcomeKind>> = {
  // The agent answered and refused: a JSON-RPC error, a data part carrying an
  // error, an MCP tool call with isError, a task ending as failed or rejected.
  PROTOCOL_NONCONFORMANT: 'declined',
  // It has no tool or skill for this, which is a refusal by capability.
  NOT_SUPPORTED_BY_PROVIDER: 'declined',
  // Nothing usable came back: DNS, a blocked address, an HTTP status.
  ENDPOINT_UNREACHABLE: 'unreachable',
  UPSTREAM_UNAVAILABLE: 'unreachable',
  // A card that will not resolve is a registration problem, not an agent one.
  INVALID_AGENT_CARD: 'unreachable',
  // Ours. The fork, the timeout around the agent, the harness.
  FORK_UNAVAILABLE: 'errored',
  EGRESS_BUDGET_EXCEEDED: 'errored',
  INVALID_REQUEST: 'errored',
  NOT_IMPLEMENTED: 'errored',
};

/**
 * Classify a caught audition failure.
 *
 * Anything that is not a `BenchError` is ours by default. A raw `TypeError`
 * from our own code is not an agent declining, and defaulting the other way
 * would let a bug in Bench be published as a fact about a stranger's agent.
 */
export function classifyAuditionFailure(err: unknown): AuditionOutcomeKind {
  if (!(err instanceof BenchError)) return 'errored';
  return BY_CODE[err.code] ?? 'errored';
}

/** Wording for a reader, singular. */
export const OUTCOME_LABEL: Readonly<Record<AuditionOutcomeKind, string>> = {
  completed: 'Completed',
  declined: 'Declined',
  unreachable: 'Unreachable',
  errored: 'Bench error',
};
