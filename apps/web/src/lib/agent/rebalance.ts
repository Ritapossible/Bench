import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

/**
 * The reference agent's one behaviour, kept out of the route so it is testable
 * without an HTTP server.
 *
 * Deliberately simple, and deliberately not tuned: a rebalance toward 50/50 is
 * a real strategy with a real edge in some windows and a real cost in others.
 * An agent that is only ever right would be a fixture, and the point of this
 * one is to prove the harness measures something rather than to win.
 */

/** PancakeSwap V2, the same address on BSC mainnet and on a fork of it. */
const ROUTER: Address = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const WBNB: Address = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';

const ROUTER_ABI = parseAbi([
  'function swapExactETHForTokens(uint amountOutMin, address[] path, address to, uint deadline) payable returns (uint[] amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] path, address to, uint deadline) returns (uint[] amounts)',
  'function getAmountsOut(uint amountIn, address[] path) view returns (uint[] amounts)',
]);
const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]);

export interface RebalanceRequest {
  readonly rpcUrl: string;
  readonly account: Address;
  readonly privateKey: Hex;
  /** The stablecoin leg of the position. */
  readonly token: Address;
  /** How far from 50/50 is close enough. Below this, doing nothing is right. */
  readonly toleranceBps?: number;
}

export interface RebalanceResult {
  readonly acted: boolean;
  readonly reason: string;
  readonly txHashes: readonly Hex[];
  readonly nativeWei: string;
  readonly tokenUnits: string;
}

/**
 * Gas left behind, so a rebalance never spends the account down to where it
 * cannot pay for its own swap.
 */
const GAS_RESERVE_WEI = 20_000_000_000_000_000n; // 0.02 BNB
const DEADLINE_SKEW = 1_800n;
/** Sized so the quote is meaningful but the probe itself costs nothing. */
const PRICE_PROBE_WEI = 10n ** 16n;

export async function rebalanceToward5050(req: RebalanceRequest): Promise<RebalanceResult> {
  const account = privateKeyToAccount(req.privateKey);
  if (account.address.toLowerCase() !== req.account.toLowerCase()) {
    /**
     * Refused rather than trading from whichever account the key happens to
     * hold. The audition scores the controller it seeded; acting from anything
     * else would record an outcome against a position nobody read.
     */
    return {
      acted: false,
      reason: `the key given signs for ${account.address}, not for the stated account`,
      txHashes: [],
      nativeWei: '0',
      tokenUnits: '0',
    };
  }

  const transport = http(req.rpcUrl);
  const pub = createPublicClient({ transport }) as PublicClient;
  const chain = {
    id: await pub.getChainId(),
    name: 'audition-fork',
    nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
    rpcUrls: { default: { http: [req.rpcUrl] } },
  } as const;
  const wallet = createWalletClient({ account, transport, chain });

  const [native, tokenBal] = await Promise.all([
    pub.getBalance({ address: req.account }),
    pub.readContract({
      address: req.token,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [req.account],
    }),
  ]);

  /**
   * The native side priced in the token, read from the pool the swap will
   * actually use rather than from an oracle. The agent is judged on what it
   * could really get, and a quote from anywhere else would not be that.
   */
  let nativeInToken = 0n;
  if (native > GAS_RESERVE_WEI) {
    const out = await quote(pub, PRICE_PROBE_WEI, [WBNB, req.token]);
    nativeInToken = (native * out) / PRICE_PROBE_WEI;
  }

  const held = { nativeWei: native.toString(), tokenUnits: tokenBal.toString() };
  const total = nativeInToken + tokenBal;
  if (total === 0n) {
    return {
      acted: false,
      reason: 'the account holds nothing to rebalance',
      txHashes: [],
      ...held,
    };
  }

  const tolerance = BigInt(req.toleranceBps ?? 500);
  const half = total / 2n;
  const drift = nativeInToken > half ? nativeInToken - half : half - nativeInToken;
  if ((drift * 10_000n) / total < tolerance) {
    /**
     * Doing nothing is a decision, and here it is the right one. Reported as a
     * decision rather than as a failure: an agent that trades a position
     * already in balance only pays gas, and the audition should score that
     * difference rather than reward motion.
     */
    return {
      acted: false,
      reason: `already within ${tolerance.toString()}bps of 50/50; trading would only cost gas`,
      txHashes: [],
      ...held,
    };
  }

  const deadline = BigInt(Math.floor(Date.now() / 1000)) + DEADLINE_SKEW;
  const hashes: Hex[] = [];

  if (nativeInToken > half) {
    // Overweight native: sell the excess for the token.
    const excessInToken = nativeInToken - half;
    const wanted = (native * excessInToken) / nativeInToken;
    const spendable = native > GAS_RESERVE_WEI ? native - GAS_RESERVE_WEI : 0n;
    const amountIn = wanted < spendable ? wanted : spendable;
    if (amountIn === 0n) {
      return {
        acted: false,
        reason: 'not enough native balance above the gas reserve to rebalance',
        txHashes: [],
        ...held,
      };
    }
    const hash = await wallet.writeContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactETHForTokens',
      args: [
        minOut(await quote(pub, amountIn, [WBNB, req.token])),
        [WBNB, req.token],
        req.account,
        deadline,
      ],
      value: amountIn,
      chain,
      account,
    });
    await pub.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  } else {
    // Overweight token: sell the excess for native.
    const amountIn = half - nativeInToken;
    const allowance = await pub.readContract({
      address: req.token,
      abi: ERC20,
      functionName: 'allowance',
      args: [req.account, ROUTER],
    });
    if (allowance < amountIn) {
      const approveHash = await wallet.writeContract({
        address: req.token,
        abi: ERC20,
        functionName: 'approve',
        args: [ROUTER, amountIn],
        chain,
        account,
      });
      await pub.waitForTransactionReceipt({ hash: approveHash });
      hashes.push(approveHash);
    }
    const hash = await wallet.writeContract({
      address: ROUTER,
      abi: ROUTER_ABI,
      functionName: 'swapExactTokensForETH',
      args: [
        amountIn,
        minOut(await quote(pub, amountIn, [req.token, WBNB])),
        [req.token, WBNB],
        req.account,
        deadline,
      ],
      chain,
      account,
    });
    await pub.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }

  return {
    acted: true,
    reason: `rebalanced toward 50/50 across ${hashes.length} transaction(s)`,
    txHashes: hashes,
    ...held,
  };
}

async function quote(
  pub: PublicClient,
  amountIn: bigint,
  path: readonly Address[],
): Promise<bigint> {
  const amounts = await pub.readContract({
    address: ROUTER,
    abi: ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [amountIn, [...path]],
  });
  return amounts[amounts.length - 1] ?? 0n;
}

/**
 * One percent below the pool's own quote.
 *
 * Bounded slippage rather than none: `amountOutMin: 0` is what makes a swap
 * free to sandwich, and an agent that submits one is telling you something
 * about itself that the catalog should be able to see.
 */
const minOut = (quoted: bigint): bigint => (quoted * 99n) / 100n;
