import {
  BenchError,
  notImplemented,
  type AgentCard,
  type AgentId,
  type AgentRecord,
  type Address,
  type ChainName,
  type Hex,
  type ListAgentsQuery,
  type EnumerateOptions,
  type EnumerationResult,
  type RegistryClient,
  type ValidationEntry,
} from '@bench/core';
import { createPublicClient, http, type PublicClient } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { CardResolver, type CardResolverOptions } from '../catalog/card-resolver.js';
import { IDENTITY_REGISTRY_ABI, ZERO_ADDRESS } from './abi/erc8004.js';

/**
 * ERC-8004 registries on BSC. Phase 1 — read path.
 *
 * Built on viem rather than @bnbagent/sdk on purpose. Reading the Identity
 * Registry is standard ERC-721 access, so it does not need the SDK, and the
 * SDK's export surface is unverified against the pinned version (see sdk.ts).
 * Keeping Phase 1 off the SDK means the catalog cannot be blocked by a
 * dependency we have not been able to check. The SDK earns its place in
 * Phase 4, where Altana session keys have no viem equivalent.
 *
 * The rule this class is written around: **an unresolvable card is the normal
 * path, not the error path.** Only ~4% of BSC registrations have a resolvable
 * card with a live endpoint. Agents whose card fails to resolve are returned
 * with `card: null` and kept in the catalog — they are the denominator of the
 * density figure Bench publishes, and dropping them would quietly inflate it.
 */

export interface RegistryClientOptions {
  readonly chain: ChainName;
  readonly rpcUrl: string;
  readonly identityRegistry: Address;
  readonly validationRegistry?: Address;
  readonly card?: CardResolverOptions;
  /**
   * getLogs block-range cap. BSC public RPCs reject wide ranges, and the limit
   * differs per provider, so it is configurable rather than a constant that
   * works on one endpoint and fails on the next.
   */
  readonly logChunkBlocks?: bigint;
}

const DEFAULT_LOG_CHUNK = 2_000n;

/** Token ids per multicall. Large enough to be cheap, small enough to stay under body limits. */
const ENUMERATE_BATCH = 200;
/** Ceiling on one enumeration call, so a tick is bounded regardless of registry size. */
const DEFAULT_ENUMERATE_LIMIT = 5_000;
/** Consecutive missing ids before the walk concludes the registry has ended. */
const DEFAULT_GAP_TOLERANCE = 25;
/** The head moves by ~2,000 a day; asking once a tick is enough. */
const HEAD_CACHE_MS = 10 * 60_000;

export class Erc8004RegistryClient implements RegistryClient {
  #head: { id: bigint; at: number } | null = null;

  readonly #client: PublicClient;
  readonly #cards: CardResolver;
  readonly #opts: RegistryClientOptions;

  constructor(opts: RegistryClientOptions) {
    this.#opts = opts;
    this.#client = createPublicClient({
      chain: opts.chain === 'bsc-mainnet' ? bsc : bscTestnet,
      transport: http(opts.rpcUrl),
    }) as PublicClient;
    this.#cards = new CardResolver(opts.card ?? {});
  }

  async headBlock(): Promise<bigint> {
    try {
      return await this.#client.getBlockNumber();
    } catch (err) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', 'getBlockNumber failed', err);
    }
  }

  /**
   * Registrations in a block range, as ERC-721 mints (Transfer from address
   * zero). Cards are NOT resolved here — that is a network call per agent
   * against arbitrary third-party hosts, which belongs to the indexer where it
   * can be batched, rate-limited, and retried independently of chain reads.
   */
  async listAgents(q: ListAgentsQuery = {}): Promise<readonly AgentRecord[]> {
    const fromBlock = q.fromBlock ?? 0n;
    const toBlock = q.cursor !== undefined ? BigInt(q.cursor) : await this.#client.getBlockNumber();
    const chunk = this.#opts.logChunkBlocks ?? DEFAULT_LOG_CHUNK;
    const limit = q.limit ?? Number.POSITIVE_INFINITY;

    const records: AgentRecord[] = [];

    for (let start = fromBlock; start <= toBlock && records.length < limit; start += chunk) {
      const end = start + chunk - 1n > toBlock ? toBlock : start + chunk - 1n;

      const logs = await this.#client.getLogs({
        address: this.#opts.identityRegistry,
        event: IDENTITY_REGISTRY_ABI[0],
        args: { from: ZERO_ADDRESS },
        fromBlock: start,
        toBlock: end,
      });

      for (const log of logs) {
        const tokenId = log.args.tokenId;
        const to = log.args.to;
        if (tokenId === undefined || to === undefined) continue;

        records.push({
          id: { chain: this.#opts.chain, tokenId },
          owner: to,
          cardUri: await this.#tokenUri(tokenId),
          card: null,
          registeredAt: await this.#blockTime(log.blockNumber),
        });
        if (records.length >= limit) break;
      }
    }

    return records;
  }

  async getAgent(id: AgentId): Promise<AgentRecord | null> {
    let owner: Address;
    try {
      owner = await this.#client.readContract({
        address: this.#opts.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'ownerOf',
        args: [id.tokenId],
      });
    } catch {
      // ERC-721 ownerOf reverts for a nonexistent token; that is a miss, not
      // an outage, so it must not propagate as an upstream failure.
      return null;
    }

    return {
      id,
      owner,
      cardUri: await this.#tokenUri(id.tokenId),
      card: null,
      registeredAt: new Date(0),
    };
  }

  /**
   * The highest minted token id, found by doubling then bisecting.
   *
   * `totalSupply()` reverts on both deployments, so there is nothing to read.
   * Roughly forty `ownerOf` calls, and the result is cached briefly because
   * the indexer asks once a tick and the answer moves by about two thousand a
   * day.
   */
  async headTokenId(): Promise<bigint> {
    const now = Date.now();
    if (this.#head !== null && now - this.#head.at < HEAD_CACHE_MS) return this.#head.id;

    const exists = async (id: bigint): Promise<boolean> => {
      const [owner] = await this.#batch([id], 'ownerOf');
      return owner !== null && owner !== undefined;
    };

    let lo = 0n;
    let hi = 1n;
    while (await exists(hi)) {
      lo = hi;
      hi *= 2n;
      // A registry larger than this is not a registry we can walk anyway, and
      // an unbounded doubling against a misbehaving node would never return.
      if (hi > 1n << 26n) break;
    }
    while (lo + 1n < hi) {
      const mid = (lo + hi) / 2n;
      if (await exists(mid)) lo = mid;
      else hi = mid;
    }
    this.#head = { id: lo, at: now };
    return lo;
  }

  /** An inclusive range, holes skipped rather than treated as the end. */
  async readTokenRange(fromTokenId: bigint, toTokenId: bigint): Promise<readonly AgentRecord[]> {
    if (toTokenId < fromTokenId) return [];
    const agents: AgentRecord[] = [];
    for (let start = fromTokenId; start <= toTokenId; start += BigInt(ENUMERATE_BATCH)) {
      const end = start + BigInt(ENUMERATE_BATCH) - 1n;
      const last = end > toTokenId ? toTokenId : end;
      const ids: bigint[] = [];
      for (let id = start; id <= last; id += 1n) ids.push(id);
      const [owners, uris] = await Promise.all([
        this.#batch(ids, 'ownerOf'),
        this.#batch(ids, 'tokenURI'),
      ]);
      for (const [i, tokenId] of ids.entries()) {
        const owner = owners[i];
        if (owner === null || owner === undefined) continue;
        agents.push({
          id: { chain: this.#opts.chain, tokenId },
          owner: owner as Address,
          cardUri: uris[i] ?? '',
          card: null,
          registeredAt: new Date(0),
        });
      }
    }
    return agents;
  }

  /**
   * Walk token ids, reading owner and card URI from current state.
   *
   * Batched with `multicall` and `allowFailure`, because a nonexistent token
   * reverts and that revert *is* the signal the walk is looking for - it has to
   * come back as a failed result rather than sink the whole batch.
   *
   * Cards are resolved after the batch rather than inside it. Almost every card
   * on this registry is a `data:` URI, which costs nothing, but an `https:` one
   * is a request to a third-party host and those belong outside a chain read
   * where they can fail independently.
   */
  async enumerateAgents(opts: EnumerateOptions = {}): Promise<EnumerationResult> {
    const from = opts.fromTokenId ?? 0n;
    const limit = opts.limit ?? DEFAULT_ENUMERATE_LIMIT;
    const gapTolerance = opts.gapTolerance ?? DEFAULT_GAP_TOLERANCE;

    const agents: AgentRecord[] = [];
    let cursor = from;
    let lastTokenId = from > 0n ? from - 1n : 0n;
    let consecutiveMisses = 0;
    let read = 0;
    let reachedEnd = false;

    while (read < limit) {
      const size = Math.min(ENUMERATE_BATCH, limit - read);
      const ids = Array.from({ length: size }, (_, i) => cursor + BigInt(i));

      const [owners, uris] = await Promise.all([
        this.#batch(ids, 'ownerOf'),
        this.#batch(ids, 'tokenURI'),
      ]);

      for (const [i, tokenId] of ids.entries()) {
        const owner = owners[i];
        if (owner === null) {
          consecutiveMisses += 1;
          // Enough consecutive holes that this is the end of the registry
          // rather than a burned token in the middle of it.
          if (consecutiveMisses > gapTolerance) {
            reachedEnd = true;
            break;
          }
          continue;
        }

        consecutiveMisses = 0;
        lastTokenId = tokenId;
        agents.push({
          id: { chain: this.#opts.chain, tokenId },
          owner: owner as Address,
          cardUri: uris[i] ?? '',
          card: null,
          // Enumeration reads state, which carries no registration block or
          // time. Left at the epoch rather than guessed at; the indexer keeps
          // whatever it already had, and a log-based read fills it in properly.
          registeredAt: new Date(0),
        });
      }

      read += size;
      cursor += BigInt(size);
      if (reachedEnd) break;
    }

    return { agents, lastTokenId, reachedEnd };
  }

  /** One multicall per function. Null where the call reverted. */
  async #batch(
    ids: readonly bigint[],
    fn: 'ownerOf' | 'tokenURI',
  ): Promise<readonly (string | null)[]> {
    try {
      const results = await this.#client.multicall({
        allowFailure: true,
        contracts: ids.map((tokenId) => ({
          address: this.#opts.identityRegistry,
          abi: IDENTITY_REGISTRY_ABI,
          functionName: fn,
          args: [tokenId] as const,
        })),
      });
      return results.map((r) => (r.status === 'success' ? String(r.result) : null));
    } catch (err) {
      throw new BenchError(
        'UPSTREAM_UNAVAILABLE',
        `multicall ${fn} failed during enumeration`,
        err,
      );
    }
  }

  /** Delegates to the resolver so URI-scheme handling has one implementation. */
  async resolveCard(uri: string): Promise<AgentCard> {
    return this.#cards.resolve(uri);
  }

  /**
   * Live registrations. viem's watcher polls `getLogs` under the hood, which
   * is what we want on BSC — public endpoints there are unreliable over
   * websockets, and a missed subscription is silent whereas a failed poll is
   * loud and retried.
   */
  async watchRegistrations(
    fromBlock: bigint,
    onAgent: (a: AgentRecord) => Promise<void>,
  ): Promise<() => void> {
    return this.#client.watchEvent({
      address: this.#opts.identityRegistry,
      event: IDENTITY_REGISTRY_ABI[0],
      args: { from: ZERO_ADDRESS },
      fromBlock,
      onLogs: (logs) => {
        void (async () => {
          for (const log of logs) {
            const tokenId = log.args.tokenId;
            const to = log.args.to;
            if (tokenId === undefined || to === undefined) continue;
            try {
              await onAgent({
                id: { chain: this.#opts.chain, tokenId },
                owner: to,
                cardUri: await this.#tokenUri(tokenId),
                card: null,
                registeredAt: await this.#blockTime(log.blockNumber),
              });
            } catch (err) {
              // One bad agent must not kill the subscription for all of them.
              console.error('[bench:registry] watch handler failed', err);
            }
          }
        })();
      },
    });
  }

  /**
   * Phase 3 (attestor). Deliberately still unimplemented: the Validation
   * Registry ABI in ./abi/erc8004.ts is UNVERIFIED, and a write against a
   * guessed signature is worse than no write — it would look like working code
   * in a demo and fail against the real contract. Verify the ABI first.
   *
   * There is intentionally no reputation write anywhere in Bench.
   */
  async writeValidation(_entry: ValidationEntry): Promise<Hex> {
    return notImplemented(
      'Erc8004RegistryClient.writeValidation (verify Validation Registry ABI first)',
    );
  }

  async anchorProbeDigest(_digest: Hex): Promise<Hex> {
    return notImplemented(
      'Erc8004RegistryClient.anchorProbeDigest (needs anchor target + wallet client)',
    );
  }

  /**
   * A reverting or missing tokenURI is extremely common and is not an error —
   * it is one of the ways an agent turns out not to be real. Empty string
   * flows through to `card: null` downstream.
   */
  async #tokenUri(tokenId: bigint): Promise<string> {
    try {
      return await this.#client.readContract({
        address: this.#opts.identityRegistry,
        abi: IDENTITY_REGISTRY_ABI,
        functionName: 'tokenURI',
        args: [tokenId],
      });
    } catch {
      return '';
    }
  }

  readonly #blockTimes = new Map<bigint, Date>();

  /** Cached: a chunk of logs usually shares a handful of blocks. */
  async #blockTime(blockNumber: bigint | null): Promise<Date> {
    if (blockNumber === null) return new Date(0);
    const hit = this.#blockTimes.get(blockNumber);
    if (hit !== undefined) return hit;
    try {
      const block = await this.#client.getBlock({ blockNumber });
      const at = new Date(Number(block.timestamp) * 1000);
      this.#blockTimes.set(blockNumber, at);
      return at;
    } catch (err) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', `getBlock(${blockNumber}) failed`, err);
    }
  }
}
