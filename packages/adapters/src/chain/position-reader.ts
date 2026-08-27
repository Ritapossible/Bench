import {
  BenchError,
  type Address,
  type ChainName,
  type Holding,
  type LivePosition,
  type LpPosition,
  type PositionReader,
} from '@bench/core';
import { createPublicClient, http, type PublicClient } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';

/**
 * Reads what an address actually holds on BSC.
 *
 * Every number here comes off chain: balances from the token contracts, prices
 * from Chainlink aggregators on BSC itself. No off-chain price API, because a
 * report whose value depends on a third-party quote is only as auditable as
 * that quote - and the whole argument of this page is that the position half is
 * a fact anyone can check.
 *
 * Read at a pinned block rather than at `latest` per call. A dozen balance
 * reads spread across changing blocks is a portfolio that never quite existed,
 * and reproducibility is the point: the block number is reported so the same
 * read can be repeated exactly.
 */

const ERC20 = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

const AGGREGATOR = [
  {
    name: 'latestRoundData',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const;

const NFPM = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'tokenOfOwnerByIndex',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'uint256' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    name: 'positions',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'uint256' }],
    outputs: [
      { name: 'nonce', type: 'uint96' },
      { name: 'operator', type: 'address' },
      { name: 'token0', type: 'address' },
      { name: 'token1', type: 'address' },
      { name: 'fee', type: 'uint24' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0', type: 'uint128' },
      { name: 'tokensOwed1', type: 'uint128' },
    ],
  },
] as const;

/**
 * Tokens and their Chainlink feeds, all verified against BSC mainnet.
 *
 * A curated set rather than every token an address holds: enumerating balances
 * for an arbitrary address needs an indexer, and a wrong or spoofed token in
 * that list would put an invented dollar figure on the page. These six cover
 * what the agent categories actually trade.
 */
interface TokenSpec {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  /** Chainlink aggregator on BSC. Null means the holding is reported unvalued. */
  readonly feed: Address | null;
}

const BSC_TOKENS: readonly TokenSpec[] = [
  {
    symbol: 'WBNB',
    address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
    decimals: 18,
    feed: '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE',
  },
  {
    symbol: 'USDT',
    address: '0x55d398326f99059fF775485246999027B3197955',
    decimals: 18,
    feed: '0xB97Ad0E74fa7d920791E90258A6E2085088b4320',
  },
  {
    symbol: 'USDC',
    address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
    decimals: 18,
    feed: '0x51597f405303C4377E36123cBc172b13269EA163',
  },
  {
    symbol: 'BTCB',
    address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c',
    decimals: 18,
    feed: '0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf',
  },
  {
    symbol: 'ETH',
    address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
    decimals: 18,
    feed: '0x9ef1B8c0E4F7dc8bF5719Ea496883DC6401d5b2e',
  },
  {
    symbol: 'CAKE',
    address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82',
    decimals: 18,
    feed: '0xB6064eD41d4f67e353768aA239cA86f4F73665a1',
  },
];

const BNB_FEED: Address = '0x0567F2323251f0Aab15c8dFb1967E4e8A7D42aeE';
const PCS_V3_POSITIONS: Address = '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364';

/**
 * How stale a price may be before it is discarded.
 *
 * Chainlink feeds update on a deviation threshold or a heartbeat, and the
 * heartbeat for a stablecoin pair is long precisely because the price does not
 * move - a USDT/USD answer twenty minutes old is healthy, not broken. This is
 * set past the longest heartbeat in the set so that normal quiet is not
 * mistaken for a dead feed, while a genuinely stalled one still drops out
 * rather than pricing the page off a number nobody is maintaining.
 */
const MAX_PRICE_AGE_MS = 26 * 60 * 60 * 1000;

/** Cap on LP positions read per address, so one whale cannot stall a page load. */
const MAX_LP_POSITIONS = 12;

export interface PositionReaderOptions {
  readonly chain: ChainName;
  readonly rpcUrl: string;
  /** Overrides the curated set. Mainly a test seam. */
  readonly tokens?: readonly TokenSpec[];
  readonly nowMs?: () => number;
}

const scale = (raw: bigint, decimals: number): number => Number(raw) / 10 ** decimals;

export class BscPositionReader implements PositionReader {
  readonly chain: ChainName;
  readonly #client: PublicClient;
  readonly #tokens: readonly TokenSpec[];
  readonly #now: () => number;

  constructor(opts: PositionReaderOptions) {
    this.chain = opts.chain;
    this.#client = createPublicClient({
      chain: opts.chain === 'bsc-mainnet' ? bsc : bscTestnet,
      transport: http(opts.rpcUrl),
    }) as PublicClient;
    this.#tokens = opts.tokens ?? BSC_TOKENS;
    this.#now = opts.nowMs ?? (() => Date.now());
  }

  async read(address: Address): Promise<LivePosition> {
    let blockNumber: bigint;
    try {
      blockNumber = await this.#client.getBlockNumber();
    } catch (err) {
      throw new BenchError('UPSTREAM_UNAVAILABLE', 'could not reach a BSC node', err);
    }

    const [native, balances, prices] = await Promise.all([
      this.#client.getBalance({ address, blockNumber }),
      this.#balances(address, blockNumber),
      this.#prices(blockNumber),
    ]);

    const bnbPrice = prices.get(BNB_FEED.toLowerCase()) ?? null;
    const holdings: Holding[] = [
      {
        token: '0x0000000000000000000000000000000000000000',
        symbol: 'BNB',
        decimals: 18,
        amount: native,
        usdValue: bnbPrice === null ? null : scale(native, 18) * bnbPrice.usd,
        pricedAt: bnbPrice?.at ?? null,
      },
    ];

    for (const [i, spec] of this.#tokens.entries()) {
      const amount = balances[i] ?? 0n;
      const price = spec.feed === null ? null : (prices.get(spec.feed.toLowerCase()) ?? null);
      holdings.push({
        token: spec.address,
        symbol: spec.symbol,
        decimals: spec.decimals,
        amount,
        usdValue: price === null ? null : scale(amount, spec.decimals) * price.usd,
        pricedAt: price?.at ?? null,
      });
    }

    const held = holdings.filter((h) => h.amount > 0n);
    return {
      address,
      chain: this.chain,
      blockNumber,
      readAt: new Date(this.#now()),
      holdings: held,
      lpPositions: await this.#lpPositions(address, blockNumber),
      valuedUsd: held.reduce((sum, h) => sum + (h.usdValue ?? 0), 0),
      partiallyValued: held.some((h) => h.usdValue === null),
    };
  }

  /**
   * One multicall rather than N round trips.
   *
   * `allowFailure` so a single token contract misbehaving costs that one
   * balance and not the whole report - the address still holds everything else,
   * and refusing to say so would be less accurate, not more careful.
   */
  async #balances(address: Address, blockNumber: bigint): Promise<bigint[]> {
    const results = await this.#client.multicall({
      blockNumber,
      allowFailure: true,
      contracts: this.#tokens.map((t) => ({
        address: t.address,
        abi: ERC20,
        functionName: 'balanceOf' as const,
        args: [address] as const,
      })),
    });
    return results.map((r) => (r.status === 'success' ? (r.result as bigint) : 0n));
  }

  async #prices(blockNumber: bigint): Promise<Map<string, { usd: number; at: Date }>> {
    const feeds = [
      ...new Set([BNB_FEED, ...this.#tokens.flatMap((t) => (t.feed === null ? [] : [t.feed]))]),
    ];
    const results = await this.#client.multicall({
      blockNumber,
      allowFailure: true,
      contracts: feeds.map((feed) => ({
        address: feed,
        abi: AGGREGATOR,
        functionName: 'latestRoundData' as const,
      })),
    });

    const out = new Map<string, { usd: number; at: Date }>();
    for (const [i, r] of results.entries()) {
      const feed = feeds[i];
      if (feed === undefined || r.status !== 'success') continue;
      const [, answer, , updatedAt] = r.result as readonly [bigint, bigint, bigint, bigint, bigint];
      // A non-positive answer is a broken feed, not a free asset.
      if (answer <= 0n) continue;
      const at = new Date(Number(updatedAt) * 1000);
      if (this.#now() - at.getTime() > MAX_PRICE_AGE_MS) continue;
      // Every Chainlink USD feed on BSC reports 8 decimals.
      out.set(feed.toLowerCase(), { usd: Number(answer) / 1e8, at });
    }
    return out;
  }

  /** PancakeSwap v3 positions. Reported by pair and range, deliberately unvalued. */
  async #lpPositions(address: Address, blockNumber: bigint): Promise<readonly LpPosition[]> {
    if (this.chain !== 'bsc-mainnet') return [];

    let count: bigint;
    try {
      count = await this.#client.readContract({
        address: PCS_V3_POSITIONS,
        abi: NFPM,
        functionName: 'balanceOf',
        args: [address],
        blockNumber,
      });
    } catch {
      // No position manager on this chain, or an unreachable node. An empty
      // list is the honest answer either way; it is not "you hold none".
      return [];
    }
    if (count === 0n) return [];

    const n = Number(count > BigInt(MAX_LP_POSITIONS) ? BigInt(MAX_LP_POSITIONS) : count);
    const ids = await this.#client.multicall({
      blockNumber,
      allowFailure: true,
      contracts: Array.from({ length: n }, (_, i) => ({
        address: PCS_V3_POSITIONS,
        abi: NFPM,
        functionName: 'tokenOfOwnerByIndex' as const,
        args: [address, BigInt(i)] as const,
      })),
    });

    const tokenIds = ids.flatMap((r) => (r.status === 'success' ? [r.result as bigint] : []));
    if (tokenIds.length === 0) return [];

    const positions = await this.#client.multicall({
      blockNumber,
      allowFailure: true,
      contracts: tokenIds.map((id) => ({
        address: PCS_V3_POSITIONS,
        abi: NFPM,
        functionName: 'positions' as const,
        args: [id] as const,
      })),
    });

    const known = new Map(this.#tokens.map((t) => [t.address.toLowerCase(), t.symbol]));
    const out: LpPosition[] = [];
    for (const [i, r] of positions.entries()) {
      const id = tokenIds[i];
      if (id === undefined || r.status !== 'success') continue;
      const p = r.result as readonly [
        bigint,
        Address,
        Address,
        Address,
        number,
        number,
        number,
        bigint,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = p;
      // A closed position keeps its NFT. Reporting it as a position would
      // overstate what the address actually has at work.
      if (liquidity === 0n) continue;
      out.push({
        tokenId: id,
        token0,
        token1,
        symbol0: known.get(token0.toLowerCase()) ?? short(token0),
        symbol1: known.get(token1.toLowerCase()) ?? short(token1),
        feeBps: Math.round(fee / 100),
        tickLower,
        tickUpper,
        liquidity,
        // Needs the pool's current tick, which is another read per distinct
        // pool. Null is honest; a guess would not be.
        inRange: null,
      });
    }
    return out;
  }
}

const short = (a: Address): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
