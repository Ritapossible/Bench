import type { SessionKeyGrant } from '../types/hire.js';
import type { Address, Hex, TokenAmount } from '../types/primitives.js';

export type WalletKind = 'evm-local' | 'twak' | 'altana';

export interface TxRequest {
  readonly to: Address;
  readonly data: Hex;
  readonly value?: bigint;
}

export interface WalletProvider {
  readonly kind: WalletKind;
  address(): Promise<Address>;
  signMessage(message: string): Promise<Hex>;
  signTypedData(payload: unknown): Promise<Hex>;
  sendTransaction(tx: TxRequest): Promise<Hex>;
}

export interface GrantSessionKeyRequest {
  readonly owner: Address;
  readonly spendCap: TokenAmount;
  readonly contractAllowlist: readonly Address[];
  readonly expiresAt: Date;
}

/**
 * Session keys are a separate port because only one provider has them:
 * `AltanaWalletProvider` (EIP-7702), which is TypeScript-only in the BNBAgent
 * SDK. Keeping this off `WalletProvider` means the other two providers do not
 * carry methods that throw, and the compiler tells us at the call site whether
 * capped, revocable authority is actually available.
 */
export interface SessionKeyProvider {
  grant(req: GrantSessionKeyRequest): Promise<SessionKeyGrant>;
  revoke(grantId: string): Promise<Hex>;
  get(grantId: string): Promise<SessionKeyGrant | null>;
  /** Remaining headroom. Throws SPEND_CAP_EXCEEDED past the cap. */
  remaining(grantId: string): Promise<TokenAmount>;
}

export const supportsSessionKeys = (w: WalletProvider): w is WalletProvider & SessionKeyProvider =>
  w.kind === 'altana';
