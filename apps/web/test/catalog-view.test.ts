import { describe, expect, it } from 'vitest';
import { showLiveOnly } from '../src/lib/catalog-view';

/**
 * The bug these pin down: `agents.entries.length === 0`, where `agents` is an
 * array. `Array.prototype.entries` is a method taking no arguments, so its
 * `.length` is 0 for every array that has ever existed - the catalog opened
 * unfiltered on every visit, and the one control that could have turned the
 * filter back on led to the URL that triggered the fallback.
 */
describe('showLiveOnly', () => {
  it('defaults to the verified-live view once anything is verified', () => {
    expect(showLiveOnly(undefined, 44)).toBe(true);
    expect(showLiveOnly(undefined, 1)).toBe(true);
  });

  it('falls back to the whole catalog when nothing is verified', () => {
    expect(showLiveOnly(undefined, 0)).toBe(false);
  });

  it('honours an explicit choice, including an empty answer', () => {
    expect(showLiveOnly('true', 0)).toBe(true);
    expect(showLiveOnly('false', 44)).toBe(false);
  });
});
