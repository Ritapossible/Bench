import { createHash } from 'node:crypto';
import {
  BenchError,
  type Address,
  type Hex,
  type PositionKind,
  type PositionTemplate,
  type TerminalState,
} from '@bench/core';
import { encodeAbiParameters, keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

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
 * The wedge position kinds. Both need a *forked* chain carrying the real
 * protocol contracts — there is nothing to seed on a bare node — so they
 * decline loudly rather than silently producing a meaningless position.
 *
 * The seeding strategy each needs is recorded here so that implementing them
 * starts from a decision rather than a blank file.
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

export const VENUS_LOAN_SEEDER = new RequiresForkSeeder(
  'venus-loan',
  'a forked chain carrying the Venus comptroller and vTokens, so collateral can be supplied and a borrow opened to reach the target health factor',
);

export const DEFAULT_SEEDERS: readonly PositionSeeder[] = [
  new SpotBalanceSeeder(),
  PCS_LP_SEEDER,
  VENUS_LOAN_SEEDER,
];
