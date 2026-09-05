import { describe, expect, it } from 'vitest';
import { assertA2AAccepted, isRunningState, readA2AReply } from '../src/agent/a2a-reply.js';

/**
 * Both payloads below are verbatim from BSC testnet agents driven at their real
 * endpoints. Each is a JSON-RPC success whose content is a refusal, and each
 * was recorded as a completed audition of zero actions.
 */
const PROOFERA = {
  kind: 'message',
  role: 'agent',
  messageId: 'lp-range-82911f78',
  parts: [
    {
      kind: 'data',
      data: {
        error: 'INVALID_A2A_ENVELOPE',
        message: 'Exactly one structured data part and no other parts are required.',
        executionEnabled: false,
      },
    },
  ],
};

const BUBBLE = {
  kind: 'message',
  role: 'agent',
  messageId: '85c231f6',
  parts: [
    {
      kind: 'data',
      data: {
        error: 'unknown skill: None',
        skills: ['negotiate', 'notify_funded'],
        hint: 'send the skill envelope as an A2A data part',
      },
    },
  ],
};

describe('a refusal carried inside result', () => {
  it('reads the agent’s own words out of a data part', () => {
    expect(readA2AReply(PROOFERA).refusal).toBe(
      'INVALID_A2A_ENVELOPE: Exactly one structured data part and no other parts are required.',
    );
    expect(readA2AReply(BUBBLE).refusal).toBe(
      'unknown skill: None (it accepts: negotiate, notify_funded)',
    );
  });

  it('fails the audition instead of scoring it as zero actions', () => {
    expect(() => assertA2AAccepted(readA2AReply(PROOFERA))).toThrow(/declined the task/);
    expect(() => assertA2AAccepted(readA2AReply(BUBBLE))).toThrow(/negotiate, notify_funded/);
  });

  it('leaves a genuine no-op alone', () => {
    // An agent that looked and chose to do nothing is a real finding, and it
    // must not be turned into a failure by this check.
    const quiet = { kind: 'message', role: 'agent', parts: [{ kind: 'text', text: 'no action' }] };
    expect(readA2AReply(quiet).refusal).toBeNull();
    expect(() => assertA2AAccepted(readA2AReply(quiet))).not.toThrow();
  });
});

describe('task states', () => {
  const task = (state: string, parts?: unknown) => ({
    kind: 'task',
    id: 't-1',
    status: { state, ...(parts === undefined ? {} : { message: { parts } }) },
  });

  it('knows which states are still running', () => {
    expect(isRunningState('submitted')).toBe(true);
    expect(isRunningState('working')).toBe(true);
    expect(isRunningState('completed')).toBe(false);
    expect(isRunningState(null)).toBe(false);
  });

  it('accepts a completed task', () => {
    expect(() => assertA2AAccepted(readA2AReply(task('completed')))).not.toThrow();
  });

  it('records an unfinished task as unfinished, not as done', () => {
    expect(() => assertA2AAccepted(readA2AReply(task('working')))).toThrow(
      /still working when the audition window closed/,
    );
  });

  it('names the states an audition cannot answer', () => {
    expect(() => assertA2AAccepted(readA2AReply(task('input-required')))).toThrow(/more input/);
    expect(() => assertA2AAccepted(readA2AReply(task('auth-required')))).toThrow(/authentication/);
    expect(() => assertA2AAccepted(readA2AReply(task('failed')))).toThrow(
      /ended the task as failed/,
    );
    expect(() => assertA2AAccepted(readA2AReply(task('rejected')))).toThrow(/rejected/);
  });

  it('finds a refusal carried on the task status message', () => {
    const reply = readA2AReply(
      task('failed', [{ kind: 'data', data: { error: 'no such skill' } }]),
    );
    expect(reply.refusal).toBe('no such skill');
    expect(() => assertA2AAccepted(reply)).toThrow(/declined the task: no such skill/);
  });

  it('survives shapes that are not replies at all', () => {
    for (const junk of [undefined, null, 'text', 42, []]) {
      const r = readA2AReply(junk);
      expect(r.kind).toBe('unknown');
      expect(() => assertA2AAccepted(r)).not.toThrow();
    }
  });
});

describe('field-level complaints', () => {
  it('carries the fields the agent said were missing', () => {
    // Verbatim from ProofEra 1825 when handed a spot-balance position. The
    // fields it names are what tell a reader it analyses V3 LP positions.
    const reply = readA2AReply({
      kind: 'message',
      parts: [
        {
          kind: 'data',
          data: {
            error: 'INVALID_ANALYSIS_INPUT',
            issues: [
              { path: 'chainId', message: 'Invalid input' },
              { path: 'poolAddress', message: 'Required' },
              { path: 'positionId', message: 'Required' },
            ],
          },
        },
      ],
    });
    expect(reply.refusal).toBe(
      'INVALID_ANALYSIS_INPUT [chainId Invalid input; poolAddress Required; positionId Required]',
    );
  });

  it('caps the list rather than printing an unbounded schema dump', () => {
    const issues = Array.from({ length: 12 }, (_, i) => ({ path: `f${i}`, message: 'Required' }));
    const reply = readA2AReply({
      kind: 'message',
      parts: [{ kind: 'data', data: { error: 'BAD', issues } }],
    });
    expect(reply.refusal).toContain('f5 Required]');
    expect(reply.refusal).not.toContain('f6');
  });
});
