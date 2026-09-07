import { describe, expect, it } from 'vitest';
import { HIRE_TRANSITIONS, isAuthorityLive, type HireState } from '../src/types/hire-flow.js';
describe('isAuthorityLive', () => {
  it('is false exactly for the states that end a mandate', () => {
    // The rule two pages had privately and disagreed about: the detail page
    // said "spend never used" on a revoked hire while the list beside it still
    // said "of cap remaining".
    for (const s of ['revoked', 'settled', 'failed'] as const) {
      expect(isAuthorityLive(s), s).toBe(false);
    }
  });

  it('is true for every other state, including ones added later', () => {
    for (const s of ['draft', 'quoted', 'authorized', 'funded', 'active', 'settling'] as const) {
      expect(isAuthorityLive(s), s).toBe(true);
    }
  });

  it('covers the whole union, so a new state cannot be forgotten', () => {
    // If HireState grows, this fails until someone decides which side it is
    // on - which is the point of writing the rule as a complement.
    const all: readonly HireState[] = [
      'draft',
      'quoted',
      'authorized',
      'funded',
      'active',
      'settling',
      'settled',
      'revoked',
      'failed',
    ];
    expect(all.filter((s) => !isAuthorityLive(s))).toEqual(['settled', 'revoked', 'failed']);
    expect(Object.keys(HIRE_TRANSITIONS).sort()).toEqual([...all].sort());
  });
});
