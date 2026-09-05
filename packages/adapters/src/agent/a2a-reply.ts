import { BenchError } from '@bench/core';

/**
 * ============================================================================
 * Reading what an A2A agent actually said back.
 * ============================================================================
 *
 * The first eighteen-agent report came back with every row at `0 actions,
 * +$0.00`, and the reason was not that eighteen agents chose to sit still. It
 * was that the shim called any HTTP 200 without a top-level `error` key a
 * completed audition. A2A agents do not decline that way. Driven at their real
 * endpoints, the two live agents in that table answered:
 *
 *   1825  {"error":"INVALID_A2A_ENVELOPE","message":"Exactly one structured
 *          data part and no other parts are required.","executionEnabled":false}
 *   1691  {"error":"unknown skill: None","skills":["negotiate","notify_funded"],
 *          "hint":"send the skill envelope as an A2A data part: ..."}
 *
 * Both are refusals, and both arrive *inside* `result`, as a data part. The
 * envelope is a valid JSON-RPC success; the content is "I did not do what you
 * asked and here is why". Bench read the envelope, ignored the content, and
 * wrote down a zero - so a refusal was published as a measured finding that
 * the agent did nothing worth paying for. That is the same mistake as calling
 * a 404 on our own wrong URL "this agent could not be driven", one layer in.
 *
 * The other silence is the task lifecycle. `message/send` may answer with a
 * Task rather than a Message, and a Task in `submitted` or `working` means the
 * agent has accepted and not finished. Treating that as done measures a fork
 * the agent has not touched yet.
 */

/** States that mean the agent has stopped, one way or another. */
const TERMINAL = new Set(['completed', 'failed', 'canceled', 'cancelled', 'rejected']);
/** States that mean it is still going and polling is worth it. */
const RUNNING = new Set(['submitted', 'working']);

export interface A2AReply {
  readonly kind: 'message' | 'task' | 'unknown';
  /** Task id, when the agent answered with a Task. */
  readonly taskId: string | null;
  readonly state: string | null;
  /** An `error` carried inside a data part - the way these agents decline. */
  readonly refusal: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The first `error` an agent put inside a data part, rendered for a reader.
 *
 * Carries the agent's own supporting fields when it offered them - 1691 names
 * the skills it does accept, and that is the single most useful sentence in
 * the whole exchange for anyone deciding whether Bench or the agent is at
 * fault.
 */
function refusalIn(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    if (!isRecord(part)) continue;
    const data = part['data'];
    if (!isRecord(data)) continue;
    const err = data['error'];
    if (typeof err !== 'string' || err === '') continue;
    const detail = typeof data['message'] === 'string' ? `: ${data['message']}` : '';
    const skills = Array.isArray(data['skills'])
      ? ` (it accepts: ${data['skills'].filter((s) => typeof s === 'string').join(', ')})`
      : '';
    return `${err}${detail}${skills}`;
  }
  return null;
}

/** Read one `message/send` or `tasks/get` result. */
export function readA2AReply(result: unknown): A2AReply {
  if (!isRecord(result)) return { kind: 'unknown', taskId: null, state: null, refusal: null };

  const kind = result['kind'];
  const status = isRecord(result['status']) ? result['status'] : undefined;
  const state = typeof status?.['state'] === 'string' ? status['state'] : null;

  // A Task carries its message under status.message; a Message carries parts
  // directly. Both can hold the refusal.
  const statusMessage = isRecord(status?.['message']) ? status['message'] : undefined;
  const refusal = refusalIn(result['parts']) ?? refusalIn(statusMessage?.['parts']);

  return {
    kind: kind === 'task' ? 'task' : kind === 'message' ? 'message' : 'unknown',
    taskId: typeof result['id'] === 'string' ? result['id'] : null,
    state,
    refusal,
  };
}

export const isRunningState = (state: string | null): boolean =>
  state !== null && RUNNING.has(state.toLowerCase());

export const isTerminalState = (state: string | null): boolean =>
  state !== null && TERMINAL.has(state.toLowerCase());

/**
 * Turn a finished reply into a failure, or return quietly.
 *
 * Every throw here records the agent's own words. An audition that ends in one
 * of these is a real finding - it is just not the finding "this agent looked
 * at your position and decided to do nothing", which is what a silent zero
 * claimed.
 */
export function assertA2AAccepted(reply: A2AReply): void {
  if (reply.refusal !== null) {
    throw new BenchError('PROTOCOL_NONCONFORMANT', `agent declined the task: ${reply.refusal}`);
  }
  const state = reply.state;
  if (state === null) return;
  const lowered = state.toLowerCase();
  if (lowered === 'completed') return;
  if (lowered === 'input-required' || lowered === 'auth-required') {
    throw new BenchError(
      'PROTOCOL_NONCONFORMANT',
      `agent asked for ${lowered === 'auth-required' ? 'authentication' : 'more input'} before ` +
        'acting, which an audition cannot supply',
    );
  }
  if (isTerminalState(state)) {
    throw new BenchError('PROTOCOL_NONCONFORMANT', `agent ended the task as ${lowered}`);
  }
  // Still running when the budget ran out. Recorded as unfinished rather than
  // as a completed run of zero actions.
  throw new BenchError(
    'UPSTREAM_UNAVAILABLE',
    `agent was still ${lowered} when the audition window closed`,
  );
}
