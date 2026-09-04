import {
  BenchError,
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
import {
  BNB,
  BNB_TESTNET,
  createClient,
  createPrivateKeySigner,
  serializeSession,
  signerFromPrivateKey,
  type Client,
  type Session,
  type SessionPermissions,
  type Signer,
  type Wallet,
} from '@altananetwork/sdk';

/**
 * ============================================================================
 * Altana self-custodial wallets and on-chain session keys.
 * ============================================================================
 *
 * The partner track asks for four things Bench had none of: agents on their
 * own Altana wallets, sessions carrying real limits, those sessions registered
 * in the KeyStore, and user-facing revocation. Every method on the old
 * provider threw `notImplemented`, which was honest at the call site and
 * invisible everywhere else.
 *
 * The distinction that makes this worth having, rather than a second spend cap
 * in a database: **the permissions are enforced by the account contract**. A
 * call outside the granted allowlist reverts at validation, whether or not
 * Bench is running, whether or not Bench agrees. Bench's own envelope gate is
 * advisory by comparison - it decides what to forward. This decides what the
 * chain will accept.
 *
 * Custody model: the admin signer is a server-held key, one per Bench
 * deployment, and each agent gets its own wallet under it. That is the honest
 * description - these are self-custodial *accounts* whose admin key Bench
 * holds, not user wallets. A user's own wallet arrives when the checkout can
 * ask a browser for a passkey, which is `createPasskeyWallet` and a UI change,
 * not a different design.
 */

export interface AltanaWalletOptions {
  /** Admin authority for the wallets this provider creates. */
  readonly adminPrivateKey: Hex;
  readonly chain: ChainName;
  /**
   * Where granted sessions are kept.
   *
   * Required, and deliberately not optional. `grantSession` mints a session
   * key that exists only in the granting process's memory; if it is lost
   * before being persisted, the on-chain authorization it created is
   * permanently unusable and revoke-and-regrant is the only way out. A store
   * that silently defaulted to a Map would turn that into a restart.
   */
  readonly sessions: SessionStore;
}

/** Somewhere a granted session survives a restart. */
export interface SessionStore {
  put(record: StoredSession): Promise<void>;
  get(id: string): Promise<StoredSession | null>;
  markRevoked(id: string, at: Date): Promise<void>;
}

export interface StoredSession {
  readonly id: string;
  readonly owner: Address;
  readonly walletAddress: Address;
  /** The session key's own private key. The secret half of the grant. */
  readonly sessionPrivateKey: Hex;
  /** `serializeSession` output - everything except the secret. */
  readonly serialized: string;
  readonly publicKey: Hex;
  readonly spendCap: TokenAmount;
  readonly contractAllowlist: readonly Address[];
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  /** The transaction that carried the grant, when the relay reported one. */
  readonly grantTxHash: Hex | null;
}

/** In-memory store. Fine for a test; loses grants on restart, and says so. */
export class InMemorySessionStore implements SessionStore {
  readonly #rows = new Map<string, StoredSession>();
  async put(record: StoredSession): Promise<void> {
    this.#rows.set(record.id, record);
  }
  async get(id: string): Promise<StoredSession | null> {
    return this.#rows.get(id) ?? null;
  }
  async markRevoked(id: string, at: Date): Promise<void> {
    const row = this.#rows.get(id);
    if (row !== undefined) this.#rows.set(id, { ...row, revokedAt: at });
  }
}

export class AltanaWalletProvider implements WalletProvider, SessionKeyProvider {
  readonly kind: WalletKind = 'altana';

  readonly #client: Client;
  readonly #admin: Signer;
  readonly #chainId: number;
  readonly #sessions: SessionStore;
  /** The wallet this provider acts as, created lazily and then reused. */
  #wallet: Wallet | null = null;

  constructor(opts: AltanaWalletOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(opts.adminPrivateKey)) {
      // Never echo it: an invalid key is still a secret.
      throw new BenchError(
        'INVALID_REQUEST',
        'Altana admin key must be a 0x-prefixed 32-byte hex string',
      );
    }
    const network = opts.chain === 'bsc-mainnet' ? BNB : BNB_TESTNET;
    this.#client = createClient({ chains: [network] });
    this.#chainId = network.chainId;
    this.#admin = signerFromPrivateKey(opts.adminPrivateKey);
    this.#sessions = opts.sessions;
  }

  /**
   * The wallet, created on first use.
   *
   * Deriving it from the admin key rather than storing one means a restart
   * finds the same account: the EIP-7702 address is the admin EOA's, so
   * `createWallet` on an already-upgraded account is a no-op that returns it.
   */
  async #walletHandle(): Promise<Wallet> {
    if (this.#wallet === null) {
      const created = await this.#client.createWallet({ signer: this.#admin });
      this.#wallet = { address: created.address };
    }
    return this.#wallet;
  }

  async address(): Promise<Address> {
    return (await this.#walletHandle()).address;
  }

  async signMessage(message: string): Promise<Hex> {
    // Deliberately unsupported rather than approximated. The account's
    // authority is exercised through `execute`, and a personal_sign here would
    // sign with the admin EOA - a different key with different authority from
    // the smart account callers believe they are talking to.
    throw new BenchError(
      'NOT_IMPLEMENTED',
      `Altana wallets sign through the account, not the admin EOA. Use sendTransaction, or ` +
        `signOrder with a session for protocol digests (message: ${message.length} chars)`,
    );
  }

  async signTypedData(_payload: unknown): Promise<Hex> {
    throw new BenchError(
      'NOT_IMPLEMENTED',
      'Altana typed-data signing goes through signOrderTypedData with a session key',
    );
  }

  /** One call, executed by the account with the admin signer's authority. */
  async sendTransaction(tx: TxRequest): Promise<Hex> {
    const wallet = await this.#walletHandle();
    const result = await this.#client.execute({
      wallet,
      signer: this.#admin,
      chainId: this.#chainId,
      calls: [{ to: tx.to, data: tx.data, ...(tx.value === undefined ? {} : { value: tx.value }) }],
    });
    return txHashOf(result);
  }

  /**
   * Grant a session key bounded by an allowlist, a spend cap and an expiry.
   *
   * The session signer is generated here and persisted before the grant is
   * reported as successful, because the SDK is explicit that a key lost before
   * persistence leaves an on-chain authorization nobody can use.
   */
  async grant(req: GrantSessionKeyRequest): Promise<SessionKeyGrant> {
    /**
     * Validated before anything touches the network.
     *
     * These are the caller's mistakes, and checking them after `createWallet`
     * meant a malformed request paid for a relay round trip to be told it was
     * malformed - and made the unit tests for these refusals reach the
     * network to prove a rule that never depended on it.
     */
    if (req.contractAllowlist.length === 0) {
      // An empty allowlist means "no contracts" everywhere else in this
      // codebase. The SDK reads an omitted `calls` as unrestricted, so passing
      // the empty case through would silently invert the bound into "every
      // contract" - the opposite of what was asked for.
      throw new BenchError(
        'INVALID_REQUEST',
        'a session with no contract allowlist would be unrestricted on chain, not restricted',
      );
    }

    const expiry = Math.floor(req.expiresAt.getTime() / 1000);
    if (expiry <= Math.floor(Date.now() / 1000)) {
      throw new BenchError('INVALID_REQUEST', 'session expiry is in the past');
    }

    if (req.spendCap.amount <= 0n) {
      // A cap of zero is not a bound, it is a session that can do nothing -
      // and a negative one is a bound that cannot be exceeded because it was
      // never a bound.
      throw new BenchError('INVALID_REQUEST', 'session spend cap must be positive');
    }

    const wallet = await this.#walletHandle();
    const sessionSigner = createPrivateKeySigner();

    const permissions: SessionPermissions = {
      calls: req.contractAllowlist.map((to) => ({ to })),
      spend: [
        {
          limit: req.spendCap.amount,
          period: 'day' as const,
          ...(isNative(req.spendCap.token) ? {} : { token: req.spendCap.token }),
        },
      ],
    };

    const granted = await this.#client.grantSession({
      wallet,
      signer: this.#admin,
      chainId: this.#chainId,
      permissions,
      expiry,
      sessionSigner,
      // KeyStore registration is what lets a third party verify this key's
      // authority on chain, which is the whole point of publishing it.
      register: true,
    });

    const id = granted.publicKey;
    await this.#sessions.put({
      id,
      owner: req.owner,
      walletAddress: wallet.address,
      sessionPrivateKey: sessionSigner._privateKey,
      serialized: JSON.stringify(serializeSession(granted)),
      publicKey: granted.publicKey,
      spendCap: req.spendCap,
      contractAllowlist: req.contractAllowlist,
      expiresAt: req.expiresAt,
      revokedAt: null,
      grantTxHash: granted.transactionHash ?? null,
    });

    return toGrant(
      {
        id,
        owner: req.owner,
        walletAddress: wallet.address,
        sessionPrivateKey: sessionSigner._privateKey,
        serialized: '',
        publicKey: granted.publicKey,
        spendCap: req.spendCap,
        contractAllowlist: req.contractAllowlist,
        expiresAt: req.expiresAt,
        revokedAt: null,
        grantTxHash: granted.transactionHash ?? null,
      },
      req.spendCap,
    );
  }

  /**
   * Revoke on chain. The KeyStore write is what makes this a control rather
   * than a flag: after it lands the account rejects the key, whether or not
   * anything of Bench's is still running.
   */
  async revoke(grantId: string): Promise<Hex> {
    const stored = await this.#requireSession(grantId);
    const wallet = await this.#walletHandle();

    const result = await this.#client.revokeSession({
      wallet,
      signer: this.#admin,
      chainId: this.#chainId,
      // The public key identifies the session; the SDK accepts it directly, so
      // revocation does not depend on rehydrating a signer we may have lost.
      session: stored.publicKey,
    });

    await this.#sessions.markRevoked(grantId, new Date());
    return txHashOf(result);
  }

  async get(grantId: string): Promise<SessionKeyGrant | null> {
    const stored = await this.#sessions.get(grantId);
    if (stored === null) return null;
    return toGrant(stored, await this.#spentAgainst(stored));
  }

  /**
   * Headroom left under the cap.
   *
   * Reported as cap-minus-spent rather than read from the account: the cap is
   * a rolling daily window enforced on chain, and there is no view function
   * that returns the remainder. Bench's own accounting is therefore a floor -
   * the chain may allow more once the window rolls - which is the safe
   * direction for a number a user reads before authorising something.
   */
  async remaining(grantId: string): Promise<TokenAmount> {
    const stored = await this.#requireSession(grantId);
    const spent = await this.#spentAgainst(stored);
    const left = stored.spendCap.amount - spent.amount;
    if (left <= 0n) {
      throw new BenchError(
        'SPEND_CAP_EXCEEDED',
        `session ${grantId} has spent its cap of ${stored.spendCap.amount.toString()}`,
      );
    }
    return { ...stored.spendCap, amount: left };
  }

  async #requireSession(grantId: string): Promise<StoredSession> {
    const stored = await this.#sessions.get(grantId);
    if (stored === null) {
      throw new BenchError('NOT_FOUND', `no Altana session key ${grantId}`);
    }
    return stored;
  }

  /**
   * What this session has spent so far.
   *
   * Zero until Bench executes through a session, which nothing does yet - the
   * hire path decides and records but signs nothing. Returning a hardcoded
   * zero from a method whose name promises otherwise is how `spentAgainst`
   * became a cap that could never trip, so this states the reason rather than
   * looking like an answer.
   */
  async #spentAgainst(stored: StoredSession): Promise<TokenAmount> {
    return { ...stored.spendCap, amount: 0n };
  }

  /** Rehydrate a stored session so an agent process can act with it. */
  async sessionFor(grantId: string): Promise<Session> {
    const stored = await this.#requireSession(grantId);
    if (stored.revokedAt !== null) {
      throw new BenchError('INVALID_REQUEST', `session ${grantId} was revoked`);
    }
    const parsed = JSON.parse(stored.serialized) as Record<string, unknown>;
    return {
      ...(parsed as unknown as Omit<Session, 'signer'>),
      signer: signerFromPrivateKey(stored.sessionPrivateKey),
    };
  }
}

const isNative = (token: Address): boolean =>
  token.toLowerCase() === '0x0000000000000000000000000000000000000000';

/**
 * The transaction hash, or a refusal.
 *
 * `execute` can report a confirmed intent without surfacing a receipt, and a
 * caller that treated the absence as success would record a state change that
 * may not have happened - the same failure the simulated escrow was corrected
 * for.
 */
function txHashOf(result: { status: string; transactionHash?: Hex; callsId: Hex }): Hex {
  if (result.status === 'FAILED') {
    throw new BenchError(
      'UPSTREAM_UNAVAILABLE',
      `Altana relay reported a failed call ${result.callsId}`,
    );
  }
  if (result.transactionHash === undefined) {
    throw new BenchError(
      'UPSTREAM_UNAVAILABLE',
      `Altana relay accepted ${result.callsId} without a transaction hash (status ${result.status})`,
    );
  }
  return result.transactionHash;
}

function toGrant(stored: StoredSession, spent: TokenAmount): SessionKeyGrant {
  return {
    id: stored.id,
    key: stored.walletAddress,
    owner: stored.owner,
    spendCap: stored.spendCap,
    spent,
    contractAllowlist: stored.contractAllowlist,
    expiresAt: stored.expiresAt,
    revokedAt: stored.revokedAt,
  };
}
