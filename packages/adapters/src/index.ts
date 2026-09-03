import { rpcUrlFor, type BenchConfig } from '@bench/config';
import {
  BenchError,
  type EscrowClient,
  type PaymentClient,
  type CrossReferenceSource,
  type ProbeClient,
  type RegistryClient,
  type WalletProvider,
} from '@bench/core';
import { buildCrossReference } from './catalog/scan-8004.js';
import { Erc8004RegistryClient } from './chain/erc8004-registry.js';
import { Erc8183EscrowClient } from './chain/erc8183-escrow.js';
import { X402PaymentClient } from './chain/x402-payment.js';
import { HttpProbeClient } from './probe/http-probe.js';
import { AnvilForkProvider } from './shadow/anvil-fork.js';
import { InMemoryEgressGuard } from './shadow/egress-guard.js';
import {
  AltanaWalletProvider,
  EvmLocalWalletProvider,
  TwakWalletProvider,
} from './wallet/providers.js';

export { Erc8004RegistryClient, type RegistryClientOptions } from './chain/erc8004-registry.js';
export { Erc8183EscrowClient } from './chain/erc8183-escrow.js';
export { X402PaymentClient } from './chain/x402-payment.js';
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
  PCS_LP_SEEDER,
  VENUS_LOAN_SEEDER,
} from './shadow/seeders.js';
export { InMemoryEgressGuard, type EgressGuardOptions } from './shadow/egress-guard.js';
export { BscPositionReader, type PositionReaderOptions } from './chain/position-reader.js';
export { A2AShadowAgent, type A2AShadowAgentOptions } from './agent/a2a-shadow-agent.js';
export { McpShadowAgent, type McpShadowAgentOptions } from './agent/mcp-shadow-agent.js';
export {
  auditionWindows,
  forkBlockFor,
  BLOCKS_PER_DAY,
  FORK_LAG_BLOCKS,
  type WindowSpec,
} from './shadow/windows.js';
export {
  AltanaWalletProvider,
  EvmLocalWalletProvider,
  TwakWalletProvider,
} from './wallet/providers.js';
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
  readonly payment: PaymentClient;
  readonly escrow: EscrowClient;
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
  readonly fork: AnvilForkProvider;
  readonly egress: InMemoryEgressGuard;
  /** No-op until ALTLAYER_8004SCAN_API_KEY is set. Never gates the catalog. */
  readonly crossRef: CrossReferenceSource;
}

export function buildAdapters(cfg: BenchConfig): Adapters {
  return {
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
    probe: new HttpProbeClient({ timeoutMs: 10_000, dnsTimeoutMs: 3_000, allowLoopback: false }),
    payment: new X402PaymentClient(),
    escrow: new Erc8183EscrowClient(),
    wallet: () => buildWallet(cfg),
    fork: new AnvilForkProvider(),
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
    case 'altana':
      return new AltanaWalletProvider();
    default: {
      const exhaustive: never = cfg.BENCH_WALLET_PROVIDER;
      throw new BenchError(
        'NOT_SUPPORTED_BY_PROVIDER',
        `unknown wallet provider ${String(exhaustive)}`,
      );
    }
  }
}
