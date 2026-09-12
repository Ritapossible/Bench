/**
 * Register Bench's reference agent in an ERC-8004 Identity Registry.
 *
 * Run once per chain, deliberately, with a funded signer:
 *
 *     BENCH_CHAIN=bsc-mainnet \
 *     BENCH_SIGNER_PRIVATE_KEY=0x… \
 *     npx tsx scripts/register-reference-agent.mts
 *
 * Four things about this script that are not incidental.
 *
 * **The chain is required, never defaulted.** These are two different
 * contracts on two different networks, and the cost of getting it wrong is not
 * symmetric: a testnet mistake is free, a mainnet one spends real BNB on a
 * registration nobody will read. So there is nothing to fall back to.
 *
 * **The entrypoint was verified on each chain rather than assumed.** On
 * testnet `register(string)` was found by pricing candidate signatures with
 * `eth_estimateGas` - it is the only one that does not revert. Mainnet runs a
 * different implementation behind its proxy, so the same assumption would have
 * been a guess; instead a real registration transaction was decoded from
 * chain, and its selector is 0xf2c298be, which is `register(string)`. Same
 * entrypoint, established rather than hoped for.
 *
 * **`totalSupply()` reverts on both**, so the next id is found by scanning
 * `ownerOf` - doubling to bracket the end, then bisecting.
 *
 * **The registration says whose agent this is.** The name carries "operated by
 * Bench" and the description says it in full. A marketplace that registers its
 * own agent anonymously and then ranks it is running a conflict of interest;
 * anyone reading a report has to be able to see which row is ours.
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseAbi,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc, bscTestnet } from 'viem/chains';
import { KNOWN_IDENTITY_REGISTRY } from '../packages/config/src/index.js';

const CHAINS = {
  'bsc-mainnet': {
    chain: bsc,
    eip155: 56,
    rpcEnv: 'BSC_MAINNET_RPC_URL',
    fallbackRpc: 'https://bsc-rpc.publicnode.com',
    explorer: 'https://bscscan.com',
  },
  'bsc-testnet': {
    chain: bscTestnet,
    eip155: 97,
    rpcEnv: 'BSC_TESTNET_RPC_URL',
    fallbackRpc: 'https://bsc-testnet-dataseed.bnbchain.org',
    explorer: 'https://testnet.bscscan.com',
  },
} as const;

type ChainKey = keyof typeof CHAINS;

const chainKey = process.env['BENCH_CHAIN'];
if (chainKey !== 'bsc-mainnet' && chainKey !== 'bsc-testnet') {
  console.error(
    `BENCH_CHAIN must be set to bsc-mainnet or bsc-testnet (got ${chainKey ?? 'nothing'}).\n` +
      'It is required rather than defaulted: these are different contracts on different ' +
      'networks, and a mainnet registration spends real BNB.',
  );
  process.exit(1);
}
const target = CHAINS[chainKey as ChainKey];
const REGISTRY = KNOWN_IDENTITY_REGISTRY[chainKey as ChainKey];
const RPC = process.env[target.rpcEnv] ?? target.fallbackRpc;
const WEB = process.env['BENCH_PUBLIC_WEB_URL'] ?? 'https://bench-bnb.vercel.app';

const REGISTRY_ABI = parseAbi([
  'function register(string tokenURI) returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
]);

const key = process.env['BENCH_SIGNER_PRIVATE_KEY'];
if (key === undefined || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error('BENCH_SIGNER_PRIVATE_KEY must be set to a 0x-prefixed 32-byte hex key');
  process.exit(1);
}

const account = privateKeyToAccount(key as `0x${string}`);
const pub = createPublicClient({ chain: target.chain, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: target.chain, transport: http(RPC) });

console.log(`chain    ${chainKey} (eip155:${target.eip155})`);
console.log(`registry ${REGISTRY}`);
console.log(`signer   ${account.address}`);

const exists = async (id: bigint): Promise<boolean> => {
  try {
    await pub.readContract({
      address: REGISTRY,
      abi: REGISTRY_ABI,
      functionName: 'ownerOf',
      args: [id],
    });
    return true;
  } catch {
    return false;
  }
};

/** The registry has no totalSupply, so the boundary is searched for. */
async function nextTokenId(): Promise<bigint> {
  let lo = 1n;
  let hi = 1n;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2n;
    if (hi > 1n << 24n) break;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo + 1n;
}

const predicted = await nextTokenId();
console.log(`next free token id: ${predicted}`);

/**
 * The same shape every other registration on these chains uses: a data: URI
 * holding the eip-8004 registration-v1 blob, whose `services[].endpoint`
 * points at the A2A agent card rather than at the service. That indirection is
 * the convention here - and reading it wrongly is what made Bench POST every
 * audition task at a static JSON file for months.
 */
const registration = {
  description:
    'Reference agent operated by Bench itself, published so the audition harness has a worked ' +
    'example end to end. Rebalances a spot BNB/stablecoin position toward 50/50 on PancakeSwap ' +
    'V2. Scored on exactly the same terms as every other agent in the catalog.',
  image: '',
  name: 'Bench Reference Rebalancer (operated by Bench)',
  registrations: [
    { agentId: Number(predicted), agentRegistry: `eip155:${target.eip155}:${REGISTRY}` },
  ],
  services: [{ endpoint: `${WEB}/.well-known/agent-card.json`, name: 'A2A', version: '0.3.0' }],
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
};

const tokenUri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
console.log(`tokenURI is ${tokenUri.length} bytes`);

const data = encodeFunctionData({
  abi: REGISTRY_ABI,
  functionName: 'register',
  args: [tokenUri],
});
const [balance, gas, gasPrice] = await Promise.all([
  pub.getBalance({ address: account.address }),
  pub.estimateGas({ account: account.address, to: REGISTRY, data }),
  pub.getGasPrice(),
]);
const cost = gas * gasPrice;
console.log(
  `estimated gas ${gas} at ${Number(gasPrice) / 1e9} gwei = ${formatEther(cost)} BNB; ` +
    `signer holds ${formatEther(balance)} BNB`,
);
if (balance < cost) {
  // Refused here rather than left to fail as a revert, because on mainnet the
  // useful message is "fund this address with this much", not "insufficient
  // funds for gas * price + value".
  console.error(
    `signer cannot cover this: fund ${account.address} with at least ${formatEther(cost)} BNB`,
  );
  process.exit(1);
}

const hash = await wallet.writeContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: 'register',
  args: [tokenUri],
  chain: target.chain,
  account,
});
console.log(`sent ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status ${receipt.status} in block ${receipt.blockNumber}`);

// Read the id back rather than trusting the prediction: another registration
// could have landed between the scan and this send - on mainnet about two
// thousand a day do - and a registration blob naming the wrong agentId is
// exactly the kind of quietly-wrong record this project keeps removing.
const minted = receipt.logs
  .map((l) => l as { address: string; topics?: readonly `0x${string}`[] })
  .filter(
    (l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && (l.topics?.length ?? 0) === 4,
  )
  .map((l) => BigInt(l.topics?.[3] ?? '0x0'));
console.log(`minted token id(s): ${minted.map((m) => m.toString()).join(', ') || 'none found'}`);
if (minted[0] !== undefined && minted[0] !== predicted) {
  console.warn(
    `WARNING: predicted ${predicted} but minted ${minted[0]}; the registration blob names the ` +
      'wrong agentId and should be re-registered.',
  );
}
console.log(`${target.explorer}/tx/${hash}`);
