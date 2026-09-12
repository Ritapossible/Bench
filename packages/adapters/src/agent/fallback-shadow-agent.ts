import { BenchError, type ShadowAgent, type ShadowAgentContext } from '@bench/core';

/**
 * ============================================================================
 * Drive an agent over every transport it declares, not just the first one.
 * ============================================================================
 *
 * The audition used to pick one endpoint - A2A where an agent declared it,
 * otherwise MCP - and stop there. That was wrong in a way only the mainnet
 * catalog made visible.
 *
 * ClawdMint, ERC-8004 token #2468, declares both. Its A2A registration points
 * at an agent card, and that card names the agent's *marketing site* in its
 * `url`, where a POST returns 404. Bench followed the standard correctly,
 * recorded "could not be driven", and moved on - while the MCP endpoint on the
 * same registration initialized cleanly and listed twelve working tools. The
 * agent was drivable the whole time. Bench published it as undrivable because
 * of a broken field in a different transport's card.
 *
 * A competing marketplace listing the same agent showed it as healthy, and it
 * was right to. A catalog whose whole claim is "we measure what agents
 * actually do" cannot afford to give up at the first declared address.
 *
 * **Which failures fall through, and which stop.** The distinction is the
 * point, not an optimisation:
 *
 *   fall through   the endpoint was never usable - a 404, DNS that does not
 *                  resolve, a card that will not parse. That is a fact about
 *                  one address, and says nothing about the agent behind the
 *                  others.
 *   stop           the agent answered and declined. That is a decision, and
 *                  the same agent sits behind every transport it publishes, so
 *                  re-asking over another one is shopping for a kinder verdict
 *                  until some address says yes.
 *
 * The first failure is the one reported when every transport fails, because it
 * is the one the agent's own registration points at first.
 */
const TRANSPORT_FAILURE = new Set([
  'ENDPOINT_UNREACHABLE',
  'UPSTREAM_UNAVAILABLE',
  'INVALID_AGENT_CARD',
]);

export class FallbackShadowAgent implements ShadowAgent {
  readonly id: string;
  readonly name: string;

  constructor(private readonly agents: readonly ShadowAgent[]) {
    const first = agents[0];
    if (first === undefined) {
      throw new BenchError('INVALID_REQUEST', 'FallbackShadowAgent needs at least one transport');
    }
    this.id = first.id;
    this.name = first.name;
  }

  async run(ctx: ShadowAgentContext): Promise<void> {
    let firstFailure: unknown;
    for (const [i, agent] of this.agents.entries()) {
      try {
        await agent.run(ctx);
        return;
      } catch (err) {
        if (i === 0) firstFailure = err;
        const transportFailed = err instanceof BenchError && TRANSPORT_FAILURE.has(err.code);
        // A decline, or our own bug, ends it here: neither gets a second
        // opinion from another address.
        if (!transportFailed) throw err;
      }
    }
    throw firstFailure;
  }
}
