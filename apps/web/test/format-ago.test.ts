import { describe, expect, it } from 'vitest';
import { ago } from '../src/lib/format';

describe('ago', () => {
  const now = new Date('2026-09-06T12:00:00Z');

  it('reads recent times in minutes, hours and days', () => {
    expect(ago(new Date('2026-09-06T11:45:00Z'), now)).toBe('15m ago');
    expect(ago(new Date('2026-09-06T09:00:00Z'), now)).toBe('3h ago');
    expect(ago(new Date('2026-09-04T12:00:00Z'), now)).toBe('2d ago');
  });

  it('never renders a negative age', () => {
    /**
     * The bug: `from` defaulted to a hardcoded 2026-08-25, so twelve days
     * later the agent page said "Last probed -17572m ago" on the panel whose
     * whole job is to say how fresh the evidence is.
     */
    expect(ago(new Date('2026-09-06T12:30:00Z'), now)).toBe('just now');
    expect(ago(now, now)).toBe('just now');
  });

  it('measures from the real clock by default', () => {
    // A timestamp a minute old must not read as days, whatever the date is.
    expect(ago(new Date(Date.now() - 60_000))).toBe('1m ago');
  });
});
