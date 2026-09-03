import { createHash } from 'node:crypto';
import {
  BenchError,
  type Address,
  type Hex,
  type PositionKind,
  type PositionTemplate,
  type TerminalState,
} from '@bench/core';
import {
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { COMPTROLLER_ABI, ERC20_ABI, VENUS, VTOKEN_ABI } from './protocols.js';

/** BSC mainnet USDT - the default collateral when a template does not name one. */
const USDT = '0x55d398326f99059ff775485246999027b3197955';

/**
 * Position seeding.
 *
 * ARCHITECTURE.md 3.3 step 2: seed the mirrored position by direct state
 * manipulation rather than by replaying the user's transactions. Faster, and
 * exact — replaying depends on the historical mempool cooperating.
 *
 * Each position kind is a separate strategy so that adding one never touches
 * the fork harness. Adding a kind must not require changing the engine.
 */

export interface SeedContext {
  /** Raw JSON-RPC against the fork, bypassing the interceptor. */
  readonly rpc: (method: string, params: readonly unknown[]) => Promise<unknown>;
  readonly controller: Address;
}

export interface PositionSeeder {
  readonly kind: PositionKind;
  /** Put the position into the fork. Returns its opening valuation. */
  seed(ctx: SeedContext, template: PositionTemplate): Promise<TerminalState>;
  /** Value the position as it now stands. Must be pure with respect to the fork. */
  read(ctx: SeedContext, template: PositionTemplate): Promise<TerminalState>;
}

/**
 * The throwaway key controlling the mirrored position, derived from the
 * window seed so that a replay of the same window controls the same address.
 * Without this the fork would differ between runs and the audition would not
 * be reproducible — which is the property the whole record rests on.
 */
export function controllerFor(seed: string): { privateKey: Hex; address: Address } {
  const pk = `0x${createHash('sha256').update(`bench:controller:${seed}`).digest('hex')}` as Hex;
  const account = privateKeyToAccount(pk);
  return { privateKey: pk, address: account.address as Address };
}

const num = (t: PositionTemplate, key: string, fallback?: number): number => {
  const v = t.params[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new BenchError('FORK_UNAVAILABLE', `position template is missing numeric param "${key}"`);
  }
  return typeof v === 'number' ? v : Number(v);
};

const big = (t: PositionTemplate, key: string, fallback?: bigint): bigint => {
  const v = t.params[key];
  if (v === undefined) {
    if (fallback !== undefined) return fallback;
    throw new BenchError('FORK_UNAVAILABLE', `position template is missing bigint param "${key}"`);
  }
  return typeof v === 'bigint' ? v : BigInt(String(v));
};

const str = (t: PositionTemplate, key: string): string | undefined => {
  const v = t.params[key];
  return v === undefined ? undefined : String(v);
};

/**
 * Native balance plus at most one ERC-20, valued at prices fixed in the
 * template.
 *
 * Prices are template parameters rather than oracle reads on purpose: an
 * audition has to produce the same number when replayed next month, and an
 * oracle read at "now" would not. The oracle belongs in the scorer, which
 * values a *live* position, not in the replayable record.
 */
export class SpotBalanceSeeder implements PositionSeeder {
  readonly kind: PositionKind = 'spot-balance';

  async seed(ctx: SeedContext, t: PositionTemplate): Promise<TerminalState> {
    const nativeWei = big(t, 'nativeWei');
    await ctx.rpc('anvil_setBalance', [ctx.controller, toHex(nativeWei)]);

    const token = str(t, 'token');
    if (token !== undefined) {
      const slot = big(t, 'balanceSlot');
      const amount = big(t, 'tokenAmount');
      // ERC-20 balances live at keccak256(abi.encode(holder, mappingSlot)).
      const key = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ctx.controller, slot]),
      );
      await ctx.rpc('anvil_setStorageAt', [token, key, toHex(amount, { size: 32 })]);
    }

    return this.read(ctx, t);
  }

  async read(ctx: SeedContext, t: PositionTemplate): Promise<TerminalState> {
    const balHex = (await ctx.rpc('eth_getBalance', [ctx.controller, 'latest'])) as string;
    const native = BigInt(balHex);
    const nativePrice = num(t, 'nativePriceUsd');
    const nativeUsd = (Number(native) / 1e18) * nativePrice;

    const detail: Record<string, number> = { nativeUsd, nativeWei: Number(native) };
    let total = nativeUsd;

    const token = str(t, 'token');
    if (token !== undefined) {
      const slot = big(t, 'balanceSlot');
      const key = keccak256(
        encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ctx.controller, slot]),
      );
      const raw = (await ctx.rpc('eth_getStorageAt', [token, key, 'latest'])) as string;
      const amount = BigInt(raw);
      const decimals = num(t, 'tokenDecimals', 18);
      const price = num(t, 'tokenPriceUsd', 1);
      const tokenUsd = (Number(amount) / 10 ** decimals) * price;
      detail['tokenUsd'] = tokenUsd;
      total += tokenUsd;
    }

    return { valueUsd: total, detail };
  }
}

/**
 * Send a transaction as the controller, on the fork.
 *
 * Impersonation rather than signing: the controller's key is derivable, but
 * `anvil_impersonateAccount` keeps the seeding path independent of nonce
 * management, and these calls are setup rather than agent behaviour - they go
 * straight to anvil and never through the interceptor, so they never appear in
 * the agent's recorded actions.
 */
async function callAs(ctx: SeedContext, to: string, data: Hex, value = 0n): Promise<void> {
  await ctx.rpc('anvil_impersonateAccount', [ctx.controller]);
  const hash = (await ctx.rpc('eth_sendTransaction', [
    {
      from: ctx.controller,
      to,
      data,
      ...(value === 0n ? {} : { value: toHex(value) }),
      gas: toHex(3_000_000n),
    },
  ])) as string;

  /**
   * Polled, not read once.
   *
   * `eth_getTransactionReceipt` immediately after `eth_sendTransaction`
   * returns null on anvil even though it auto-mines - so the first version of
   * this check read null, skipped the `status === '0x0'` branch, and passed a
   * reverted setup call as success. A guard that cannot fire is worse than no
   * guard, because the failure then surfaces two calls later as an
   * uninterpretable "math error" from the protocol.
   */
  const receipt = await waitForReceipt(ctx, hash);
  if (receipt === null) {
    throw new BenchError('FORK_UNAVAILABLE', `seeding call to ${to} was never mined`);
  }
  if (receipt.status === '0x0') {
    throw new BenchError('FORK_UNAVAILABLE', `seeding call to ${to} reverted`);
  }
}

async function waitForReceipt(ctx: SeedContext, hash: string): Promise<{ status?: string } | null> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const receipt = (await ctx.rpc('eth_getTransactionReceipt', [hash])) as {
      status?: string;
    } | null;
    if (receipt !== null) return receipt;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

/** Read a view function on the fork, bypassing the interceptor. */
async function callStatic(ctx: SeedContext, to: string, data: Hex): Promise<Hex> {
  return (await ctx.rpc('eth_call', [{ to, data, from: ctx.controller }, 'latest'])) as Hex;
}

/**
 * A Venus supply-and-borrow position, seeded on a fork carrying the real
 * protocol.
 *
 * This is what a health-factor agent is for, and until now the category could
 * not be auditioned at all: the seeder declined, so every health-factor agent
 * was handed a spot balance with no loan to protect and scored on a position
 * that had no health factor. One of the four judged categories, measured
 * against the wrong thing.
 *
 * Seeded by driving the real contracts rather than by writing Venus's storage.
 * Writing it directly would mean reproducing the protocol's accounting -
 * exchange rates, interest indices, the comptroller's market membership - and
 * any drift between our version and theirs shows up as an agent's action
 * failing for reasons that have nothing to do with the agent.
 */
export class VenusLoanSeeder implements PositionSeeder {
  readonly kind: PositionKind = 'venus-loan';

  async seed(ctx: SeedContext, t: PositionTemplate): Promise<TerminalState> {
    const nativeWei = big(t, 'nativeWei', 10n ** 18n);
    await ctx.rpc('anvil_setBalance', [ctx.controller, toHex(nativeWei)]);

    const underlying = (str(t, 'token') ?? USDT) as Address;
    const vToken = (str(t, 'vToken') ?? VENUS.vUSDT) as Address;
    const supply = big(t, 'supplyAmount');
    const slot = big(t, 'balanceSlot', 1n);

    // Collateral into the controller's wallet by storage write - the same
    // trick the spot seeder uses, and the only step that is not a real call.
    const key = keccak256(
      encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [ctx.controller, slot]),
    );
    await ctx.rpc('anvil_setStorageAt', [underlying, key, toHex(supply, { size: 32 })]);

    await callAs(
      ctx,
      underlying,
      encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [vToken, supply] }),
    );
    await callAs(
      ctx,
      vToken,
      encodeFunctionData({ abi: VTOKEN_ABI, functionName: 'mint', args: [supply] }),
    );
    await callAs(
      ctx,
      VENUS.comptroller,
      encodeFunctionData({
        abi: COMPTROLLER_ABI,
        functionName: 'enterMarkets',
        args: [[vToken]],
      }),
    );

    /**
     * Borrow to a target health factor, computed from the market's own
     * collateral factor rather than from a constant.
     *
     * Venus health factor is (collateral * collateralFactor) / borrowed, so
     * the borrow that lands on `targetHealthFactor` is
     * supply * cf / target. Reading `cf` from the comptroller means the
     * position is at the health factor the template asked for even when Venus
     * changes the parameter - which it does.
     */
    const marketRaw = await callStatic(
      ctx,
      VENUS.comptroller,
      encodeFunctionData({ abi: COMPTROLLER_ABI, functionName: 'markets', args: [vToken] }),
    );
    const [, collateralFactorMantissa] = decodeFunctionResult({
      abi: COMPTROLLER_ABI,
      functionName: 'markets',
      data: marketRaw,
    }) as [boolean, bigint, boolean];

    const target = num(t, 'targetHealthFactor', 1.5);
    const borrow =
      ((supply * collateralFactorMantissa) / 10n ** 18n / BigInt(Math.round(target * 1_000))) *
      1_000n;

    if (borrow > 0n) {
      await callAs(
        ctx,
        vToken,
        encodeFunctionData({ abi: VTOKEN_ABI, functionName: 'borrow', args: [borrow] }),
      );
    }

    const opened = await this.read(ctx, t);
    // A position that seeded to nothing means a call silently no-opped, and
    // auditioning against it would score every agent zero for a fork fault.
    if (opened.valueUsd <= 0) {
      throw new BenchError(
        'FORK_UNAVAILABLE',
        'venus-loan seeded to a zero-value position; the fork may not carry the protocol',
      );
    }
    return opened;
  }

  /**
   * Net equity: what the position is worth to its owner.
   *
   * Supplied minus borrowed, which is the quantity a health-factor agent is
   * protecting - a liquidation destroys equity, and an agent that repays to
   * avoid one has kept it. Valuing the supply alone would score an agent that
   * borrowed recklessly the same as one that did not.
   */
  async read(ctx: SeedContext, t: PositionTemplate): Promise<TerminalState> {
    const vToken = (str(t, 'vToken') ?? VENUS.vUSDT) as Address;
    const decimals = num(t, 'tokenDecimals', 18);
    const price = num(t, 'tokenPriceUsd', 1);

    // `balanceOfUnderlying` and `borrowBalanceCurrent` are non-view (they
    // accrue interest first), so they are read with eth_call, which runs them
    // without committing - the accrual is exactly what makes the number right.
    const suppliedRaw = await callStatic(
      ctx,
      vToken,
      encodeFunctionData({
        abi: VTOKEN_ABI,
        functionName: 'balanceOfUnderlying',
        args: [ctx.controller],
      }),
    );
    const borrowedRaw = await callStatic(
      ctx,
      vToken,
      encodeFunctionData({
        abi: VTOKEN_ABI,
        functionName: 'borrowBalanceCurrent',
        args: [ctx.controller],
      }),
    );

    const supplied = BigInt(suppliedRaw === '0x' ? '0x0' : suppliedRaw);
    const borrowed = BigInt(borrowedRaw === '0x' ? '0x0' : borrowedRaw);

    const suppliedUsd = (Number(supplied) / 10 ** decimals) * price;
    const borrowedUsd = (Number(borrowed) / 10 ** decimals) * price;

    const walletRaw = await callStatic(
      ctx,
      (str(t, 'token') ?? USDT) as Address,
      encodeFunctionData({ abi: ERC20_ABI, functionName: 'balanceOf', args: [ctx.controller] }),
    );
    const walletUsd =
      (Number(BigInt(walletRaw === '0x' ? '0x0' : walletRaw)) / 10 ** decimals) * price;

    const nativeHex = (await ctx.rpc('eth_getBalance', [ctx.controller, 'latest'])) as string;
    const nativeUsd = (Number(BigInt(nativeHex)) / 1e18) * num(t, 'nativePriceUsd', 0);

    return {
      valueUsd: suppliedUsd - borrowedUsd + walletUsd + nativeUsd,
      detail: {
        suppliedUsd,
        borrowedUsd,
        walletUsd,
        nativeUsd,
        // Reported so a reader can see what the agent was protecting, and so
        // the health-factor metric has a real number behind it.
        healthFactor: borrowedUsd === 0 ? 0 : (suppliedUsd * 0.8) / borrowedUsd,
      },
    };
  }
}

/**
 * The remaining position kind. Needs a *forked* chain carrying the real
 * protocol contracts — there is nothing to seed on a bare node — so it
 * declines loudly rather than silently producing a meaningless position.
 */
class RequiresForkSeeder implements PositionSeeder {
  constructor(
    readonly kind: PositionKind,
    private readonly needs: string,
  ) {}

  async seed(): Promise<TerminalState> {
    throw new BenchError(
      'NOT_IMPLEMENTED',
      `the ${this.kind} seeder needs ${this.needs}; run against a forked archive node`,
    );
  }

  async read(): Promise<TerminalState> {
    return this.seed();
  }
}

export const PCS_LP_SEEDER = new RequiresForkSeeder(
  'pcs-lp',
  'a forked chain carrying the PancakeSwap v3 position manager, so a position NFT can be minted to the controller and its tick range set directly',
);

export const DEFAULT_SEEDERS: readonly PositionSeeder[] = [
  new SpotBalanceSeeder(),
  new VenusLoanSeeder(),
  PCS_LP_SEEDER,
];
