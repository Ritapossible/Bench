/**
 * ============================================================================
 * Registrations that are scaffolding, not agents.
 * ============================================================================
 *
 * A reader's report is about their own money, and the first four rows of it
 * were `studio-agent` four times over, followed by four `LingoAI ... (demo)`
 * entries. Every one of those is a genuine on-chain registration with a live
 * endpoint, so none of them is a lie - but a page that opens with four
 * identical scaffold names reads as noise rather than as a catalog, and the
 * agent a reader might actually hire is below the fold.
 *
 * Two rules govern what goes in here, because a filter on a measurement page
 * is the easiest place in this codebase to start quietly deciding what counts:
 *
 * **Only self-declared markers.** An agent is excluded because it called
 * itself a demo, a test, a starter or a tutorial, or because it still carries
 * the default name its builder tool generated. Never because its numbers are
 * uninteresting, never because it is unfamiliar, and never because its
 * category is one Bench does not score. `My Personal Holon - Swahili
 * Translation` stays: it is irrelevant to a USDT position, and irrelevant is
 * not the same as fake.
 *
 * **Excluded from the reader's table, never from the measurement.** These
 * agents are still indexed, still probed, still auditioned, and still counted
 * in every registry figure Bench publishes. The catalog page still lists them.
 * This is a presentation rule for one page, not a change to the denominator -
 * a filter that moved the density number would be the same dishonesty the
 * number exists to expose.
 */

/**
 * Words an agent uses about itself when it is not offering a service.
 *
 * Bounded to whole words, where a hyphen, a space and a bracket all count as
 * the boundary: `demo` is caught in `LingoAI Grid Trading Agent (demo)` and in
 * `demo-agent`, and is not caught inside `Demography Signals`. That cuts both
 * ways and is the intended trade - a name built out of the word `starter` is
 * declaring the same thing whether or not a space follows it.
 */
const SELF_DECLARED =
  /(^|[^a-z])(demo|test|testnet|example|sample|tutorial|starter|placeholder|scaffold|dummy|todo|wip)($|[^a-z])/i;

/**
 * Default names builder tools emit before anyone renames the agent.
 *
 * Matched whole, not as a substring: `studio-agent` is scaffolding, and an
 * agent that named itself `Grid Studio Agent` chose that.
 */
const SCAFFOLD_NAMES = new Set([
  'studio-agent',
  'my agent',
  'my first agent',
  'new agent',
  'agent',
  'untitled agent',
  'untitled',
  'hello world',
  'hello-world',
]);

/**
 * Whether a registration presents itself as scaffolding.
 *
 * Reads the name and, only for the self-declared markers, the description -
 * an agent whose name is clean but whose description opens "demo agent for
 * testing" is telling you the same thing. The scaffold-name check is on the
 * name alone, because a description mentioning `studio-agent` is prose.
 */
export function looksLikeTestRegistration(name: string, description = ''): boolean {
  const trimmed = name.trim().toLowerCase();
  if (trimmed === '') return false;
  if (SCAFFOLD_NAMES.has(trimmed)) return true;
  return SELF_DECLARED.test(name) || SELF_DECLARED.test(description);
}
