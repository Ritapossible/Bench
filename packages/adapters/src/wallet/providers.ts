import {
  BenchError,
  notImplemented,
  type Address,
  type ChainName,
  type GrantSessionKeyRequest,
  type Hex,
  type SessionKeyGrant,
  type SessionKeyProvider,
  type TokenAmount,
  type TxRequest,
  type WalletKind,
  type WalletProvider,
} from '@bench/core';
import { createWalletClient, http, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';

export interface EvmLocalWalletOptions {
  /** 0x-prefixed 32-byte key. Read from config by the caller, never from here. */
  readonly privateKey: Hex;
  readonly chain: ChainName;
  readonly rpcUrl: string;
}

/**
 * Local key custody. Fine for workers and seed agents, not for user funds.
 *
 * Every method used to throw, which meant Bench had no signing capability
 * anywhere while the site described a session key signing cleared actions. A
 * stub that throws is honest at the call site and invisible in a screenshot,
 * and this is the one provider whose custody model Bench can actually
 * implement: the other two are remote services with SDKs this build does not
 * carry, and they still refuse rather than pretend.
 *
 * The key is passed in rather than read from the environment here, so the
 * process decides once - at boot, where a missing key is a configuration error
 * - instead of each call site discovering it independently.
 */
export class EvmLocalWalletProvider implements WalletProvider {
  readonly kind: WalletKind = 'evm-local';
  readonly #account: PrivateKeyAccount;
  readonly #client: WalletClient;

  constructor(opts: EvmLocalWalletOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.privateKey)) {
      // Never echo the value: an invalid key is still a secret, and a message
      // quoting it puts it in every log that catches this.
      throw new BenchError(
        'INVALID_REQUEST',
        'BENCH_SIGNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex string',
      );
    }
    this.#account = privateKeyToAccount(opts.privateKey);
    this.#client = createWalletClient({
      account: this.#account,
      chain: opts.chain === 'bsc-mainnet' ? bsc : bscTestnet,
      transport: http(opts.rpcUrl),
    });
  }

  async address(): Promise<Address> {
    return this.#account.address;
  }

  async signMessage(message: string): Promise<Hex> {
    return this.#account.signMessage({ message });
  }

  /**
   * EIP-712. Typed here as `unknown` by the port because the payload shape is
   * the caller's, so it is validated before it reaches viem rather than cast
   * through - an unchecked cast would turn a malformed payload into a signature
   * over something nobody inspected.
   */
  async signTypedData(payload: unknown): Promise<Hex> {
    if (typeof payload !== 'object' || payload === null) {
      throw new BenchError('INVALID_REQUEST', 'typed-data payload must be an object');
    }
    const p = payload as Record<string, unknown>;
    if (
      typeof p['primaryType'] !== 'string' ||
      typeof p['types'] !== 'object' ||
      p['types'] === null
    ) {
      throw new BenchError(
        'INVALID_REQUEST',
        'typed-data payload needs `types` and a `primaryType`',
      );
    }
    return this.#account.signTypedData(
      payload as Parameters<PrivateKeyAccount['signTypedData']>[0],
    );
  }

  async sendTransaction(tx: TxRequest): Promise<Hex> {
    return this.#client.sendTransaction({
      account: this.#account,
      chain: this.#client.chain,
      to: tx.to,
      data: tx.data,
      ...(tx.value === undefined ? {} : { value: tx.value }),
    });
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
