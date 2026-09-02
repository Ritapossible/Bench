import { z } from 'zod';

/**
 * The regex already proves the shape, so the transform makes the *type* say
 * what the validation has established. Without it every consumer receives
 * `string` and has to re-assert `0x${string}` at the call site — which is
 * both noisy and a place to get it wrong.
 */
const hexAddress = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x address')
  .transform((s) => s as `0x${string}`);

const schema = z.object({
  BENCH_CHAIN: z.enum(['bsc-mainnet', 'bsc-testnet']).default('bsc-testnet'),
  BSC_TESTNET_RPC_URL: z.string().url(),
  BSC_MAINNET_RPC_URL: z.string().url().optional(),

  /**
   * The chain auditions fork, which is not the chain agents register on.
   *
   * Identity lives where ERC-8004 is deployed - BSC testnet, where the mainnet
   * proxy is an unactivated stub holding zero agents. Markets live on mainnet.
   * An audition replays market history, so it forks mainnet and drives agents
   * whose identity is on testnet; tying the two together forked a chain with
   * no liquidity, no USDT and nothing to measure.
   *
   * BSC_ARCHIVE_RPC_URL must point at this chain. The worker checks it at boot
   * rather than trusting it.
   */
  SHADOW_FORK_CHAIN: z.enum(['bsc-mainnet', 'bsc-testnet']).default('bsc-mainnet'),

  // Shadow engine needs historical state; a pruned node cannot serve it.
  // Optional rather than required, because it gates *auditions* and nothing
  // else - the indexer and prober are the worker's whole job until an archive
  // node exists, and refusing to boot without one blocked a deployment that
  // would have worked. `requireArchiveRpc` raises it at the point of use, where
  // the message can say which feature needs it.
  BSC_ARCHIVE_RPC_URL: z.string().url().optional(),

  ERC8004_IDENTITY_REGISTRY: hexAddress,
  // Only `writeValidation` needs this, which nothing calls yet. Required, it
  // stopped the worker booting for a feature it does not run.
  ERC8004_VALIDATION_REGISTRY: hexAddress.optional(),
  ERC8004_REPUTATION_REGISTRY: hexAddress.optional(),

  // Block the Identity Registry was deployed at. Indexing from 0 means hours
  // of getLogs over empty ranges before the first agent appears.
  ERC8004_REGISTRY_START_BLOCK: z.coerce.number().int().nonnegative().default(0),

  /**
   * Read by `Erc8183EscrowClient`, whose methods are stubs on this build. Kept
   * validated rather than removed so a deployment that sets them is told
   * immediately that they are not addresses, instead of finding out when the
   * escrow client is implemented - but they configure nothing today, and the
   * README says so rather than leaving the presence of the variable to imply
   * a wired integration.
   */
  ERC8183_AGENTIC_COMMERCE: hexAddress.optional(),
  ERC8183_EVALUATOR_ROUTER: hexAddress.optional(),

  X402_FACILITATOR_URL: z.string().url().optional(),
  X402_DEFAULT_SCHEME: z.enum(['eip3009', 'permit2-exact', 'permit2-upto']).default('permit2-upto'),
  X402_SETTLEMENT_TOKEN: z.enum(['U', 'USDT', 'USD1', 'USDC']).default('USDT'),

  BENCH_WALLET_PROVIDER: z.enum(['evm-local', 'twak', 'altana']).default('evm-local'),
  BENCH_SIGNER_PRIVATE_KEY: z.string().optional(),
  ALTANA_API_KEY: z.string().optional(),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  SHADOW_EGRESS_BUDGET_USD: z.coerce.number().positive().default(0.25),
  // Defaults to the data hosts an agent plausibly needs, rather than to the
  // empty string. Empty means deny-all, which is the right *failure* mode but a
  // useless default: it silently guaranteed every audition ran with no network,
  // and nothing said so.
  SHADOW_EGRESS_ALLOWLIST: z
    .string()
    .default('api.binance.com,api.coingecko.com,api.pancakeswap.info,api.thegraph.com')
    .transform((s) =>
      s
        .split(',')
        .map((h) => h.trim())
        .filter(Boolean),
    ),
  SHADOW_MAX_CONCURRENT_FORKS: z.coerce.number().int().positive().default(4),

  ALTLAYER_8004SCAN_API_KEY: z.string().optional(),
});

export type BenchConfig = z.infer<typeof schema>;

let cached: BenchConfig | null = null;

/** Parse and validate the environment. Fails loudly at boot, never at 3am. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BenchConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid Bench configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}

export const rpcUrlFor = (c: BenchConfig): string =>
  c.BENCH_CHAIN === 'bsc-mainnet'
    ? (c.BSC_MAINNET_RPC_URL ??
      (() => {
        throw new Error('BSC_MAINNET_RPC_URL required for bsc-mainnet');
      })())
    : c.BSC_TESTNET_RPC_URL;

/**
 * The archive RPC, or a refusal that names what needs it.
 *
 * Auditions replay historical state, which a pruned node cannot serve. That is
 * a real requirement of the shadow engine and of nothing else, so it is raised
 * where the shadow engine is constructed rather than at config load - making it
 * a boot-time requirement grounded a worker whose indexing and probing were
 * perfectly able to run.
 */
export function requireArchiveRpc(c: BenchConfig): string {
  if (c.BSC_ARCHIVE_RPC_URL === undefined) {
    throw new Error(
      'BSC_ARCHIVE_RPC_URL is not set. Auditions replay historical chain state, which a ' +
        'pruned node cannot serve. Indexing and probing run without it; auditions do not.',
    );
  }
  return c.BSC_ARCHIVE_RPC_URL;
}
