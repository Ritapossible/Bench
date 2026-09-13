/**
 * Which view the catalog opens in.
 *
 * Small and separate because it got this wrong in a way no type could catch.
 * The page held the agent list in an array and asked `agents.entries.length
 * === 0` to decide whether the verified-live filter had matched anything.
 * `Array.prototype.entries` is a method, a function of no arguments, so
 * `.length` is 0 - always, for every array, full or empty. The fallback fired
 * on every visit: the catalog opened unfiltered with "Showing 244 of 32,048",
 * the checkbox sat unticked, and clicking it went to `/agents`, which fell
 * back again. There was no way to reach the verified-live view by hand while
 * the landing page next door reported 44 of them.
 *
 * A predicate over two numbers cannot make that mistake, and it can be tested.
 */
export function showLiveOnly(param: string | undefined, liveMatches: number): boolean {
  // An explicit choice is honoured either way: `?live=true` gets an honest
  // empty page rather than a helpful one, and `?live=false` gets the raw
  // registry read it asked for.
  if (param !== undefined) return param !== 'false';
  // Unasked: verified-live is the right default once anything is verified, and
  // a filter matching none of a catalog of thousands reads as a marketplace
  // with nothing in it rather than a selective one.
  return liveMatches > 0;
}
