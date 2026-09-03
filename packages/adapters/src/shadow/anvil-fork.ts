import {
  BenchError,
  replayHash as coreReplayHash,
  type AuditionWindow,
  type Address,
  type ForkHandle,
  type ForkProvider,
  type Hex,
  type InterceptedAction,
  type PositionTemplate,
  type SeededPosition,
  type SpawnForkOptions,
  type TerminalState,
} from '@bench/core';
import { startAnvil, type AnvilHandle } from './anvil-process.js';
import { startInterceptor, type InterceptorHandle } from './interceptor.js';
import type { RpcGateway, RpcRoute } from './rpc-gateway.js';
import {
  controllerFor,
  DEFAULT_SEEDERS,
  type PositionSeeder,
  type SeedContext,
} from './seeders.js';

/**
 * The shadow engine's fork provider — ARCHITECTURE.md 3.3, the longest pole.
 *
 * Composition, in the order the agent experiences it:
 *
 *   1. anvil, forked at the window's block from an ARCHIVE node.
 *   2. The position seeded by direct state manipulation (see seeders.ts).
 *   3. An interceptor in front of anvil's port. **That is the RPC the agent
 *      gets**, and every `eth_sendRawTransaction` through it is decoded,
 *      executed against fork state, and recorded. The agent believes it is
 *      live, because from where it is standing there is no difference.
 *   4. On window close, terminal state is read and the fork destroyed.
 *
 * `replayHash` delegates to @bench/core so that the value published with an
 * outcome record and the value a third party recomputes come from exactly one
 * implementation.
 */
export interface AnvilForkProviderOptions {
  readonly binary?: string;
  readonly chainId?: number;
  readonly startupTimeoutMs?: number;
  readonly seeders?: readonly PositionSeeder[];
  /**
   * Run anvil with no `--fork-url`.
   *
   * TEST AFFORDANCE, not a production mode: it exists so the interception and
   * recording path can be exercised without an archive node, which is most of
   * the engine and all of the part that is easy to get wrong. Production
   * always forks — a bare chain has no position to mirror.
   */
  readonly forkless?: boolean;
  /**
   * Publishes each fork's interceptor under a per-run token so an agent that
   * is not on this host can reach it. Absent means loopback URLs, which is
   * right for tests and local development and cannot work against a real
   * registered agent.
   */
  readonly gateway?: RpcGateway;
}

class AnvilForkHandle implements ForkHandle {
  readonly #callbacks: ((a: InterceptedAction) => void)[] = [];
  readonly #actions: InterceptedAction[] = [];
  #destroyed = false;

  constructor(
    readonly id: string,
    private readonly anvil: AnvilHandle,
    private readonly interceptor: InterceptorHandle,
    /**
     * The public route to this fork's interceptor, when one was published.
     *
     * Held so `destroy` can withdraw it: a route that outlives its fork is a
     * URL pointing at a port that has been reused, and the whole reason the
     * token is per-run is that it stops working when the run does.
     */
    private readonly route: RpcRoute | null,
    private readonly gateway: RpcGateway | null,
    private readonly seeders: readonly PositionSeeder[],
    private readonly controller: Address,
  ) {}

  /**
   * The agent's RPC: the interceptor, never anvil directly, and never the
   * loopback address when a public route exists.
   *
   * This getter returned `interceptor.url` - `http://127.0.0.1:<port>` - and
   * that string was POSTed to agents on other people's infrastructure, which
   * could not reach it. No remote agent could transact, so every measured
   * delta was structurally zero.
   */
  get rpcUrl(): string {
    return this.route?.url ?? this.interceptor.url;
  }

  /** Bench's own RPC: anvil directly, so seeding is not recorded as agent activity. */
  #rpc = async (method: string, params: readonly unknown[]): Promise<unknown> => {
    const res = await fetch(this.anvil.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    if (body.error) throw new BenchError('FORK_UNAVAILABLE', `${method}: ${body.error.message}`);
    return body.result;
  };

  #ctx(): SeedContext {
    return { rpc: this.#rpc, controller: this.controller };
  }

  #seederFor(kind: PositionTemplate['kind']): PositionSeeder {
    const s = this.seeders.find((x) => x.kind === kind);
    if (s === undefined) {
      throw new BenchError(
        'NOT_SUPPORTED_BY_PROVIDER',
        `no seeder registered for position kind "${kind}"`,
      );
    }
    return s;
  }

  async seedPosition(t: PositionTemplate): Promise<SeededPosition> {
    this.#assertLive();
    const openedAt = await this.#seederFor(t.kind).seed(this.#ctx(), t);
    return { controller: this.controller, openedAt };
  }

  onAction(cb: (a: InterceptedAction) => void): void {
    // Replay what has already happened, so a late subscriber sees the whole
    // run rather than its tail. Auditions are short and the buffer is bounded
    // by the agent's own activity.
    for (const a of this.#actions) cb(a);
    this.#callbacks.push(cb);
  }

  /** Called by the interceptor for every transaction, in sequence order. */
  dispatch(a: InterceptedAction): void {
    this.#actions.push(a);
    for (const cb of this.#callbacks) cb(a);
  }

  get actions(): readonly InterceptedAction[] {
    return this.#actions;
  }

  async terminalState(t: PositionTemplate): Promise<TerminalState> {
    this.#assertLive();
    return this.#seederFor(t.kind).read(this.#ctx(), t);
  }

  async gasPriceWei(): Promise<bigint> {
    this.#assertLive();
    // Read from anvil directly, not through the interceptor: this is Bench
    // asking, not the agent, and it should not appear in the agent's trace.
    const res = await fetch(this.anvil.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_gasPrice', params: [] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result === undefined ? 0n : BigInt(body.result);
  }

  async destroy(): Promise<void> {
    if (this.#destroyed) return;
    this.#destroyed = true;
    // Route first, then interceptor, then anvil: withdrawing the public token
    // before anything stops answering means a late request from the agent gets
    // a clean "no such audition" instead of a proxy error naming a local port.
    if (this.route !== null) this.gateway?.unregister(this.route.token);
    await this.interceptor.close();
    await this.anvil.stop();
  }

  #assertLive(): void {
    if (this.#destroyed)
      throw new BenchError('FORK_UNAVAILABLE', `fork ${this.id} has been destroyed`);
  }
}

export class AnvilForkProvider implements ForkProvider {
  constructor(private readonly opts: AnvilForkProviderOptions = {}) {}

  async spawn(opts: SpawnForkOptions): Promise<ForkHandle> {
    const { window } = opts;
    const { address: controller } = controllerFor(window.seed);

    const anvil = await startAnvil({
      ...(this.opts.forkless === true
        ? {}
        : { forkUrl: opts.archiveRpcUrl, forkBlockNumber: window.forkBlock }),
      ...(this.opts.binary === undefined ? {} : { binary: this.opts.binary }),
      ...(this.opts.chainId === undefined ? {} : { chainId: this.opts.chainId }),
      ...(this.opts.startupTimeoutMs === undefined
        ? {}
        : { startupTimeoutMs: this.opts.startupTimeoutMs }),
    });

    let handle: AnvilForkHandle | undefined;
    let interceptor: InterceptorHandle | undefined;
    let route: RpcRoute | null = null;
    try {
      interceptor = await startInterceptor({
        upstreamUrl: anvil.url,
        onAction: (a) => handle?.dispatch(a),
      });

      const forkId = `fork_${window.id}_${anvil.port}`;
      // Published under a fresh per-run token when a gateway exists, so an
      // agent elsewhere can reach this fork - and only this one, and only
      // until it is destroyed.
      route = this.opts.gateway?.register(interceptor.url, forkId) ?? null;

      handle = new AnvilForkHandle(
        forkId,
        anvil,
        interceptor,
        route,
        this.opts.gateway ?? null,
        this.opts.seeders ?? DEFAULT_SEEDERS,
        controller,
      );

      // The controller pays gas for whatever the agent does on its behalf.
      // Seeding sets the real balance immediately afterwards; this only makes
      // sure a fork is never handed over with an unfunded controller.
      await fetch(anvil.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'anvil_setBalance',
          params: [controller, `0x${(10n ** 18n).toString(16)}`],
        }),
      });

      return handle;
    } catch (err) {
      // Never leave a node - or a live public route - behind because
      // construction failed halfway.
      if (route !== null) this.opts.gateway?.unregister(route.token);
      await interceptor?.close();
      await anvil.stop();
      throw err;
    }
  }

  replayHash(window: AuditionWindow): Hex {
    return coreReplayHash(window);
  }
}

export { controllerFor } from './seeders.js';
export type { PositionSeeder, SeedContext } from './seeders.js';
