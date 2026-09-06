import { describe, expect, it } from 'vitest';
import { BenchError, type BenchErrorCode } from '../src/types/primitives.js';
import { classifyAuditionFailure } from '../src/audition-outcome.js';

const err = (code: BenchErrorCode): BenchError => new BenchError(code, 'because');

describe('classifyAuditionFailure', () => {
  it('separates an agent saying no from a registration nobody can reach', () => {
    // The two are one number today and mean opposite things: the first is a
    // fact about the agent, the second about how it registered.
    expect(classifyAuditionFailure(err('PROTOCOL_NONCONFORMANT'))).toBe('declined');
    expect(classifyAuditionFailure(err('NOT_SUPPORTED_BY_PROVIDER'))).toBe('declined');
    expect(classifyAuditionFailure(err('ENDPOINT_UNREACHABLE'))).toBe('unreachable');
    expect(classifyAuditionFailure(err('UPSTREAM_UNAVAILABLE'))).toBe('unreachable');
    expect(classifyAuditionFailure(err('INVALID_AGENT_CARD'))).toBe('unreachable');
  });

  it('names our own failures as ours', () => {
    expect(classifyAuditionFailure(err('FORK_UNAVAILABLE'))).toBe('errored');
    expect(classifyAuditionFailure(err('EGRESS_BUDGET_EXCEEDED'))).toBe('errored');
  });

  it('blames Bench for anything it does not recognise', () => {
    /**
     * The direction that matters. Every published number in this project was
     * once a Bench bug wearing an agent's name - a loopback RPC, a POST at an
     * agent card, a refusal read as a success. Defaulting an unrecognised
     * throw to "declined" would put the next one on a stranger's page.
     */
    expect(classifyAuditionFailure(new TypeError('cannot read properties of undefined'))).toBe(
      'errored',
    );
    expect(classifyAuditionFailure('a string')).toBe('errored');
    expect(classifyAuditionFailure(undefined)).toBe('errored');
    expect(classifyAuditionFailure(err('TRACE_TAMPERED'))).toBe('errored');
  });
});
