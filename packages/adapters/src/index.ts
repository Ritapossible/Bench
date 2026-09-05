import { rpcUrlFor, type BenchConfig } from '@bench/config';
import {
  BenchError,
  type CrossReferenceSource,
  type ProbeClient,
  type RegistryClient,
  type WalletProvider,
} from '@bench/core';
import { buildCrossReference } from './catalog/scan-8004.js';
import { Erc8004RegistryClient } from './chain/erc8004-registry.js';
import { HttpProbeClient } from './probe/http-probe.js';
import { AltanaWalletProvider, InMemorySessionStore } from './wallet/altana.js';
import { AnvilForkProvider } from './shadow/anvil-fork.js';
import { RpcGateway } from './shadow/rpc-gateway.js';
import { InMemoryEgressGuard } from './shadow/egress-guard.js';
import { EvmLocalWalletProvider, TwakWalletProvider } from './wallet/providers.js';

export { Erc8004RegistryClient, type RegistryClientOptions } from './chain/erc8004-registry.js';
export { Erc8183EscrowClient, type Erc8183EscrowOptions } from './chain/erc8183-escrow.js';
export { X402PaymentClient, type X402PaymentOptions } from './chain/x402-payment.js';
export {
  IDENTITY_REGISTRY_ABI,
  REGISTERED_EVENT,
  VALIDATION_REGISTRY_ABI,
} from './chain/abi/erc8004.js';
export {
  CardResolver,
  normalizeCard,
  inferCategory,
  toFetchableUrl,
  type CardResolverOptions,
} from './catalog/card-resolver.js';
export { HttpProbeClient, extractSseData, type ProbeOptions } from './probe/http-probe.js';
export {
  MIN_AUDITIONABLE_USD,
  mirrorPosition,
  NATIVE_TOKEN,
  reportWindowFor,
  SEEDABLE_TOKENS,
  type MirroredPosition,
} from './shadow/windows.js';
export { RpcGateway, type RpcGatewayOptions, type RpcRoute } from './shadow/rpc-gateway.js';
export {
  checkArchiveRpc,
  checkAuditionPreconditions,
  type ArchiveStatus,
  type AuditionPreflight,
} from './shadow/archive.js';
export {
  Scan8004CrossReference,
  buildCrossReference,
  parseAgentPayload,
  type Scan8004Options,
} from './catalog/scan-8004.js';
export {
  safeFetch,
  assertPublicUrl,
  type SafeFetchOptions,
  type SafeResponse,
} from './net/safe-fetch.js';
export {
  AnvilForkProvider,
  controllerFor,
  type AnvilForkProviderOptions,
  type PositionSeeder,
  type SeedContext,
} from './shadow/anvil-fork.js';
export {
  startAnvil,
  freePort,
  type AnvilHandle,
  type AnvilOptions,
} from './shadow/anvil-process.js';
export {
  startInterceptor,
  type InterceptorHandle,
  type InterceptorOptions,
} from './shadow/interceptor.js';
export {
  startGatedSession,
  type GatedSessionHandle,
  type GatedSessionOptions,
} from './shadow/gated-session.js';
export { decodeAction, jsonSafe, KNOWN_SELECTORS, type DecodedAction } from './shadow/tx-decode.js';
export {
  SpotBalanceSeeder,
  DEFAULT_SEEDERS,
  PancakeLpSeeder,
  VenusLoanSeeder,
} from './shadow/seeders.js';
export { InMemoryEgressGuard, type EgressGuardOptions } from './shadow/egress-guard.js';
export {
  BscPositionReader,
  BSC_TOKENS,
  type PositionReaderOptions,
} from './chain/position-reader.js';
export { A2AShadowAgent, type A2AShadowAgentOptions } from './agent/a2a-shadow-agent.js';
export {
  looksLikeAgentCard,
  resolveA2AServiceUrl,
  serviceUrlFromCard,
} from './agent/a2a-service-url.js';
export { McpShadowAgent, type McpShadowAgentOptions } from './agent/mcp-shadow-agent.js';
export {
  auditionWindows,
  forkBlockFor,
  BLOCKS_PER_DAY,
  FORK_LAG_BLOCKS,
  type WindowSpec,
} from './shadow/windows.js';
export { EvmLocalWalletProvider, TwakWalletProvider } from './wallet/providers.js';
export {
  AltanaWalletProvider,
  InMemorySessionStore,
  type AltanaWalletOptions,
  type SessionStore,
  type StoredSession,
} from './wallet/altana.js';
export { FakeRegistryClient, InMemoryCatalogRepository } from './fakes.js';
export { SDK_PINNED_VERSION, assertSdkVersion } from './sdk.js';

/**
 * The composition root. Everything downstream receives ports, never concrete
 * adapters — so tests inject fakes and production injects chain clients
 * without either side knowing the difference.
 */
export interface Adapters {
  readonly registry: RegistryClient;
  readonly probe: ProbeClient;
  /**
   * Built on demand, not at boot.
   *
   * Signing needs a key, and the worker - which indexes, probes and auditions,
   * none of which sign anything - has no reason to hold one. Constructing this
   * eagerly would turn "this deployment does not sign" into a process that
   * refuses to start. A caller that does need a signature gets the
   * configuration error at the moment it needs one, which is where it can be
   * acted on.
   */
  readonly wallet: () => WalletProvider;
  /**
   * Settlement is deliberately absent.
   *
   * `payment` and `escrow` used to sit here. Both need an Altana wallet and an
   * admin key that the indexer, prober and audition queues do not have and do
   * not want, so they became thunks that threw on the way to being called -
   * which is a stub wearing a different shape, and nothing called them anyway.
   *
   * The hire runtime in apps/web builds `Erc8183EscrowClient` where it holds
   * the key and can decide whether to settle for real. Anything else that
   * needs to settle should do the same, at the point where it has the
   * configuration to do it honestly.
   */
  readonly fork: AnvilForkProvider;
  /**
   * Publishes each fork's RPC under a per-run token. Exposed so the worker can
   * mount it on the port its host actually publishes - the gateway needs a
   * public port, and the worker owns the only one.
   */
  readonly rpcGateway: RpcGateway;
  readonly egress: InMemoryEgressGuard;
  /** No-op until ALTLAYER_8004SCAN_API_KEY is set. Never gates the catalog. */
  readonly crossRef: CrossReferenceSource;
}

/**
 * @param gateway Injected rather than built here because the worker has to
 * mount it on its HTTP server, and that server starts before this runs - it
 * has to answer "the process is up" while a bad DATABASE_URL is still hanging.
 * Passing one guarantees the fork provider and the HTTP server share a route
 * table; two would mean tokens that resolve on one and 404 on the other.
 */
export function buildAdapters(cfg: BenchConfig, gateway?: RpcGateway): Adapters {
  const rpcGateway = gateway ?? new RpcGateway({ publicBaseUrl: cfg.BENCH_PUBLIC_RPC_BASE_URL });

  return {
    rpcGateway,
    registry: new Erc8004RegistryClient({
      chain: cfg.BENCH_CHAIN,
      rpcUrl: rpcUrlFor(cfg),
      identityRegistry: cfg.ERC8004_IDENTITY_REGISTRY,
      ...(cfg.ERC8004_VALIDATION_REGISTRY === undefined
        ? {}
        : { validationRegistry: cfg.ERC8004_VALIDATION_REGISTRY }),
    }),
    // Loopback stays off: the prober fetches URLs declared by strangers, and
    // registration is gas-free, so an endpoint of http://localhost:5432 is a
    // free probe of our own infrastructure. See net/safe-fetch.ts.
    // 10s, not 5s. Most registered agents sit on free serverless tiers that
    // cold-start, so five seconds measured how warm a host happened to be as
    // much as whether it was alive. DNS gets its own budget on top - see
    // SafeFetchOptions.dnsTimeoutMs.
    // DNS at 8s, not 3s. safe-fetch's own measurement puts resolution at p99
    // 2426ms at this concurrency, which is a cliff sitting directly on a
    // 3000ms budget - so a share of what the catalog recorded as "unreachable"
    // was our timeout rather than the agent. The budgets are independent:
    // safeFetch excludes resolution time from the request budget, so this
    // widens the floor without shortening the 10s an endpoint gets to answer.
    probe: new HttpProbeClient({ timeoutMs: 10_000, dnsTimeoutMs: 8_000, allowLoopback: false }),
    wallet: () => buildWallet(cfg),
    fork: new AnvilForkProvider({ gateway: rpcGateway }),
    egress: new InMemoryEgressGuard({
      budgetUsd: cfg.SHADOW_EGRESS_BUDGET_USD,
      allowlist: cfg.SHADOW_EGRESS_ALLOWLIST,
    }),
    crossRef: buildCrossReference(
      cfg.ALTLAYER_8004SCAN_API_KEY === undefined ? {} : { apiKey: cfg.ALTLAYER_8004SCAN_API_KEY },
    ),
  };
}

function buildWallet(cfg: BenchConfig): WalletProvider {
  switch (cfg.BENCH_WALLET_PROVIDER) {
    case 'evm-local': {
      // The only provider whose custody model this build implements. Without a
      // key it refuses at boot rather than at the first signature: a wallet
      // that cannot sign is a configuration error, and discovering it hours
      // later during a settlement is the worst time to find out.
      if (cfg.BENCH_SIGNER_PRIVATE_KEY === undefined) {
        throw new BenchError(
          'INVALID_REQUEST',
          'BENCH_WALLET_PROVIDER=evm-local needs BENCH_SIGNER_PRIVATE_KEY',
        );
      }
      return new EvmLocalWalletProvider({
        privateKey: cfg.BENCH_SIGNER_PRIVATE_KEY as `0x${string}`,
        chain: cfg.BENCH_CHAIN,
        rpcUrl: rpcUrlFor(cfg),
      });
    }
    case 'twak':
      return new TwakWalletProvider();
    case 'altana': {
      // The same key as evm-local: it is the wallet's admin authority rather
      // than the account itself, and requiring a second variable for the same
      // secret is how a deployment ends up with two.
      if (cfg.BENCH_SIGNER_PRIVATE_KEY === undefined) {
        throw new BenchError(
          'INVALID_REQUEST',
          'BENCH_WALLET_PROVIDER=altana needs BENCH_SIGNER_PRIVATE_KEY as the wallet admin key',
        );
      }
      return new AltanaWalletProvider({
        adminPrivateKey: cfg.BENCH_SIGNER_PRIVATE_KEY as `0x${string}`,
        chain: cfg.BENCH_CHAIN,
        // In-memory by default and loud about it: a session key lost before it
        // is persisted leaves an on-chain grant nobody can use.
        sessions: new InMemorySessionStore(),
      });
    }
    default: {
      const exhaustive: never = cfg.BENCH_WALLET_PROVIDER;
      throw new BenchError(
        'NOT_SUPPORTED_BY_PROVIDER',
        `unknown wallet provider ${String(exhaustive)}`,
      );
    }
  }
}
export {
  assertA2AAccepted,
  isRunningState,
  isTerminalState,
  readA2AReply,
  type A2AReply,
} from './agent/a2a-reply.js';
