import { rpcUrlFor, type BenchConfig } from '@bench/config';
import {
  BenchError,
  type EscrowClient,
  type PaymentClient,
  type ProbeClient,
  type RegistryClient,
  type WalletProvider,
} from '@bench/core';
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
export { startAnvil, freePort, type AnvilHandle, type AnvilOptions } from './shadow/anvil-process.js';
export { startInterceptor, type InterceptorHandle, type InterceptorOptions } from './shadow/interceptor.js';
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
  readonly wallet: WalletProvider;
  readonly fork: AnvilForkProvider;
  readonly egress: InMemoryEgressGuard;
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
    probe: new HttpProbeClient({ timeoutMs: 5_000, allowLoopback: false }),
    payment: new X402PaymentClient(),
    escrow: new Erc8183EscrowClient(),
    wallet: buildWallet(cfg),
    fork: new AnvilForkProvider(),
    egress: new InMemoryEgressGuard({
      budgetUsd: cfg.SHADOW_EGRESS_BUDGET_USD,
      allowlist: cfg.SHADOW_EGRESS_ALLOWLIST,
    }),
  };
}

function buildWallet(cfg: BenchConfig): WalletProvider {
  switch (cfg.BENCH_WALLET_PROVIDER) {
    case 'evm-local':
      return new EvmLocalWalletProvider();
    case 'twak':
      return new TwakWalletProvider();
    case 'altana':
      return new AltanaWalletProvider();
    default: {
      const exhaustive: never = cfg.BENCH_WALLET_PROVIDER;
      throw new BenchError('NOT_SUPPORTED_BY_PROVIDER', `unknown wallet provider ${String(exhaustive)}`);
    }
  }
}
