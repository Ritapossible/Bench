import type { BenchConfig } from '@bench/config';
import { BenchError, type EscrowClient, type PaymentClient, type RegistryClient, type WalletProvider } from '@bench/core';
import { Erc8004RegistryClient } from './chain/erc8004-registry.js';
import { Erc8183EscrowClient } from './chain/erc8183-escrow.js';
import { X402PaymentClient } from './chain/x402-payment.js';
import { AnvilForkProvider } from './shadow/anvil-fork.js';
import { InMemoryEgressGuard } from './shadow/egress-guard.js';
import {
  AltanaWalletProvider,
  EvmLocalWalletProvider,
  TwakWalletProvider,
} from './wallet/providers.js';

export { Erc8004RegistryClient } from './chain/erc8004-registry.js';
export { Erc8183EscrowClient } from './chain/erc8183-escrow.js';
export { X402PaymentClient } from './chain/x402-payment.js';
export { AnvilForkProvider } from './shadow/anvil-fork.js';
export { InMemoryEgressGuard, type EgressGuardOptions } from './shadow/egress-guard.js';
export {
  AltanaWalletProvider,
  EvmLocalWalletProvider,
  TwakWalletProvider,
} from './wallet/providers.js';
export { FakeRegistryClient } from './fakes.js';
export { SDK_PINNED_VERSION, assertSdkVersion } from './sdk.js';

/**
 * The composition root. Everything downstream receives ports, never concrete
 * adapters — so tests inject fakes and production injects chain clients
 * without either side knowing the difference.
 */
export interface Adapters {
  readonly registry: RegistryClient;
  readonly payment: PaymentClient;
  readonly escrow: EscrowClient;
  readonly wallet: WalletProvider;
  readonly fork: AnvilForkProvider;
  readonly egress: InMemoryEgressGuard;
}

export function buildAdapters(cfg: BenchConfig): Adapters {
  return {
    registry: new Erc8004RegistryClient(),
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
