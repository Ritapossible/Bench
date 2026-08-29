import type { Address } from '../types/primitives.js';
import type { AuditionWindow, PositionTemplate } from '../types/audition.js';

/**
 * An agent under audition - ARCHITECTURE.md 2.
 *
 * A port in core rather than a type in services, because both sides implement
 * against it: services drives it, and the adapter that speaks A2A to a real
 * registered agent implements it. Left in services it would have forced
 * adapters to depend on services, which is the cycle the layering exists to
 * prevent.
 */
export interface ShadowAgentContext {
  /** The interceptor's RPC. The agent cannot tell it is not a live node. */
  readonly rpcUrl: string;
  /** The throwaway account holding the mirrored position. */
  readonly controller: Address;
  readonly window: AuditionWindow;
  readonly position: PositionTemplate;
  /**
   * The only way out to the network, metered against this run's egress budget.
   *
   * The fork sandboxes the agent's *transactions*; it does nothing about its
   * HTTP. A shadowed agent still makes real, billable calls - x402-paid data
   * feeds, price oracles, LLM inference - and a hundred auditions of an agent
   * that polls in a loop is a real invoice. Every call is checked before it is
   * made and recorded after.
   *
   * Passed to the agent rather than left for it to find, because a control the
   * agent has to opt into is not a control.
   */
  readonly fetch: MeteredFetch;
}

/**
 * A fetch with a price attached.
 *
 * The cost is the caller's estimate of what the request bills - an x402 data
 * feed quotes it, an unpaid endpoint is zero. Estimated before and recorded
 * after, because the two can differ and the budget has to hold against
 * whichever is larger.
 */
export type MeteredFetch = (
  url: string,
  init?: { readonly estimatedCostUsd?: number } & RequestInit,
) => Promise<Response>;

/**
 * In production a thin shim that hands the RPC endpoint to a real registered
 * agent over A2A or MCP; in tests, a function. The runner does not care which.
 */
export interface ShadowAgent {
  readonly id: string;
  readonly name: string;
  run(ctx: ShadowAgentContext): Promise<void>;
}
