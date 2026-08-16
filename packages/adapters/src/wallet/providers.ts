import {
  notImplemented,
  type Address,
  type GrantSessionKeyRequest,
  type Hex,
  type SessionKeyGrant,
  type SessionKeyProvider,
  type TokenAmount,
  type TxRequest,
  type WalletKind,
  type WalletProvider,
} from '@bench/core';

/** Local key custody. Fine for workers and seed agents, not for user funds. */
export class EvmLocalWalletProvider implements WalletProvider {
  readonly kind: WalletKind = 'evm-local';

  async address(): Promise<Address> {
    return notImplemented('EvmLocalWalletProvider.address');
  }
  async signMessage(_message: string): Promise<Hex> {
    return notImplemented('EvmLocalWalletProvider.signMessage');
  }
  async signTypedData(_payload: unknown): Promise<Hex> {
    return notImplemented('EvmLocalWalletProvider.signTypedData');
  }
  async sendTransaction(_tx: TxRequest): Promise<Hex> {
    return notImplemented('EvmLocalWalletProvider.sendTransaction');
  }
}

/** Trust Wallet AgentKit — keys never leave the user's device. */
export class TwakWalletProvider implements WalletProvider {
  readonly kind: WalletKind = 'twak';

  async address(): Promise<Address> {
    return notImplemented('TwakWalletProvider.address');
  }
  async signMessage(_message: string): Promise<Hex> {
    return notImplemented('TwakWalletProvider.signMessage');
  }
  async signTypedData(_payload: unknown): Promise<Hex> {
    return notImplemented('TwakWalletProvider.signTypedData');
  }
  async sendTransaction(_tx: TxRequest): Promise<Hex> {
    return notImplemented('TwakWalletProvider.sendTransaction');
  }
}

/**
 * Altana, EIP-7702. The ONLY provider with session keys, which is why it
 * implements both ports — and why the Altana track requirement (spend caps,
 * contract allowlists, user-visible revocation) lands on this class.
 *
 * TypeScript-only upstream. Phase 4.
 */
export class AltanaWalletProvider implements WalletProvider, SessionKeyProvider {
  readonly kind: WalletKind = 'altana';

  async address(): Promise<Address> {
    return notImplemented('AltanaWalletProvider.address');
  }
  async signMessage(_message: string): Promise<Hex> {
    return notImplemented('AltanaWalletProvider.signMessage');
  }
  async signTypedData(_payload: unknown): Promise<Hex> {
    return notImplemented('AltanaWalletProvider.signTypedData');
  }
  async sendTransaction(_tx: TxRequest): Promise<Hex> {
    return notImplemented('AltanaWalletProvider.sendTransaction');
  }

  async grant(_req: GrantSessionKeyRequest): Promise<SessionKeyGrant> {
    return notImplemented('AltanaWalletProvider.grant');
  }
  async revoke(_grantId: string): Promise<Hex> {
    return notImplemented('AltanaWalletProvider.revoke');
  }
  async get(_grantId: string): Promise<SessionKeyGrant | null> {
    return notImplemented('AltanaWalletProvider.get');
  }
  async remaining(_grantId: string): Promise<TokenAmount> {
    return notImplemented('AltanaWalletProvider.remaining');
  }
}
