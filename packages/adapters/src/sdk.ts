/**
 * ============================================================================
 * SDK QUARANTINE — the only module in Bench permitted to import @bnbagent/sdk.
 * ============================================================================
 *
 * `@bnbagent/sdk` is pinned to an exact version (0.5.0) and is self-described
 * upstream as "under active development, may introduce breaking changes". It
 * is a 0.x line, so a minor bump can and will move the API.
 *
 * The rule: nothing outside this file imports the SDK. Everything else depends
 * on the ports in @bench/core. When the SDK breaks, the blast radius is this
 * file plus the adapters that call it — not the codebase.
 *
 * Re-export the narrow surface Bench actually needs below, and nothing more.
 * A small surface is what makes the next upgrade cheap.
 *
 * NOT YET WIRED: the real import is commented out because the SDK's exact
 * export surface has not been verified against 0.5.0 yet. Verifying it and
 * filling these in is the first task of Phase 1 — do it before writing any
 * adapter body, or the adapters will be written against a guessed API.
 */

// import { ... } from '@bnbagent/sdk';

export const SDK_PINNED_VERSION = '0.5.0' as const;

/**
 * Wallet provider kinds the SDK ships. Note AltanaWalletProvider (EIP-7702
 * session keys) is TypeScript-only — that constraint is why this whole
 * codebase is TypeScript rather than Python.
 */
export const SDK_WALLET_PROVIDERS = [
  'EVMWalletProvider',
  'TWAKProvider',
  'AltanaWalletProvider',
] as const;

export type SdkWalletProviderName = (typeof SDK_WALLET_PROVIDERS)[number];

/** Guard so a silent SDK upgrade shows up as a loud failure at boot. */
export function assertSdkVersion(actual: string): void {
  if (actual !== SDK_PINNED_VERSION) {
    throw new Error(
      `@bnbagent/sdk version drift: expected ${SDK_PINNED_VERSION}, got ${actual}. ` +
        `Re-verify the adapter surface in packages/adapters/src/sdk.ts before unpinning.`,
    );
  }
}
