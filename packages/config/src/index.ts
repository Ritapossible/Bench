import { z } from 'zod';

type ChainName = 'bsc-mainnet' | 'bsc-testnet';

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
   * Identity lives on BSC testnet for this deployment. Markets live on
   * mainnet. An audition replays market history, so it forks mainnet and
   * drives agents whose identity is on testnet; tying the two together forked
   * a chain with no liquidity, no USDT and nothing to measure.
   *
   * This said the mainnet registry was "an unactivated stub holding zero
   * agents", and that was wrong in a way worth naming: the proxy at
   * ERC8004_IDENTITY_REGISTRY really is uninitialized on mainnet, but the
   * mainnet registry is a *different contract* - 0x8004a169fb4a3325136eb29fa0ceb6d2e539a432,
   * `AgentIdentity`, ~343,000 tokens. Checking one address on the wrong chain
   * and concluding the chain was empty is the same mistake this codebase keeps
   * finding elsewhere: a fact written down beside the thing that knew it, and
   * then trusted after it stopped being true. See scripts/mainnet-triage.mts,
   * which measures that registry rather than assuming anything about it.
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

  /**
   * Public origin this worker is reachable at, e.g.
   * `https://bench-worker.up.railway.app`.
   *
   * An audition hands the agent an RPC endpoint and measures what it does with
   * it. The interceptor that serves that endpoint binds to loopback, because
   * it can mint balances and impersonate accounts - so without a public origin
   * to route through, a registered agent on someone else's infrastructure
   * cannot reach it, cannot transact, and every measured delta is zero. That
   * was the state of production: one completed audition, zero transactions,
   * +$0.00, and no way for any agent to have scored anything else.
   *
   * Optional because local development and the test suite drive in-process
   * agents over loopback quite happily. The worker warns loudly at boot when
   * it is auditioning remote agents without one.
   */
  BENCH_PUBLIC_RPC_BASE_URL: z.string().url().optional(),

  ALTLAYER_8004SCAN_API_KEY: z.string().optional(),
});

/**
 * The Identity Registry on each chain, and the one address that is a trap.
 *
 * These are different contracts, not one deployment reachable from two RPCs.
 * BSC testnet holds `Agent` at 0x8004A818…; BSC mainnet holds `AgentIdentity`
 * at 0x8004a169…, with ~343,000 tokens. The addresses look alike - both were
 * vanity-mined to start 0x8004 - and that similarity cost this project real
 * time: 0x8004A818… also exists on mainnet, as an EIP-1967 proxy whose
 * implementation is uninitialized, so every read against it reverts. Pointed
 * there, Bench does not fail. It indexes an empty registry, reports zero
 * agents, and looks like a working deployment of a dead ecosystem.
 *
 * So the pairing is checked at boot. A silent empty catalog is the failure
 * this codebase keeps finding, and this is the cheapest place to refuse it.
 */
export const KNOWN_IDENTITY_REGISTRY: Readonly<Record<ChainName, `0x${string}`>> = {
  'bsc-mainnet': '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432',
  'bsc-testnet': '0x8004A818BFB912233c491871b3d84c89A494BD9e',
};

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
  assertRegistryMatchesChain(parsed.data);
  cached = parsed.data;
  return cached;
}

/**
 * Refuse a registry address that belongs to the other chain.
 *
 * Named rather than guessed: the config keeps the address it was given and is
 * told which one this chain actually uses, so a deliberate override - a fork,
 * a local deployment, a successor contract - still works and only the known
 * cross-chain mix-up is refused.
 */
export function registryMismatch(chain: ChainName, address: string): string | null {
  const mine = KNOWN_IDENTITY_REGISTRY[chain];
  const given = address.toLowerCase();
  if (given === mine.toLowerCase()) return null;
  // An address belonging to no known chain is a deliberate override - a fork, a
  // local deployment, a successor contract - and is left alone. Only the
  // cross-chain mix-up is refused.
  const other = (Object.keys(KNOWN_IDENTITY_REGISTRY) as ChainName[]).find(
    (k) => KNOWN_IDENTITY_REGISTRY[k].toLowerCase() === given,
  );
  if (other === undefined) return null;
  return (
    `ERC8004_IDENTITY_REGISTRY: ${address} is the ${other} registry, but BENCH_CHAIN is ` +
    `${chain}. Use ${mine}. These are separate contracts, and the testnet address also exists ` +
    'on mainnet as an uninitialized proxy - pointed there Bench indexes nothing and reports an ' +
    'empty registry instead of failing.'
  );
}

function assertRegistryMatchesChain(c: BenchConfig): void {
  const problem = registryMismatch(c.BENCH_CHAIN, c.ERC8004_IDENTITY_REGISTRY);
  if (problem !== null) throw new Error(`Invalid Bench configuration:\n  ${problem}`);
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
