/**
 * Register Bench's reference agent in the ERC-8004 Identity Registry.
 *
 * Run once, deliberately, with a funded signer:
 *
 *     BENCH_SIGNER_PRIVATE_KEY=0x… npx tsx scripts/register-reference-agent.mts
 *
 * Two things about this script that are not incidental.
 *
 * **The entrypoint was discovered, not assumed.** `IDENTITY_REGISTRY_ABI`
 * carries only the ERC-721 reads Bench needs to index; nothing in the codebase
 * had ever written to this contract. `register(string tokenURI)` was found by
 * pricing candidate signatures against the deployed registry with
 * `eth_estimateGas` - it is the only one that does not revert, at ~189k gas.
 * `totalSupply()` reverts, so the next id is found by scanning `ownerOf`.
 *
 * **The registration says whose agent this is.** The name carries "operated by
 * Bench" and the description says it in full. A marketplace that registers its
 * own agent anonymously and then ranks it is running a conflict of interest;
 * anyone reading a report has to be able to see which row is ours.
 */
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';

const RPC = process.env['BSC_TESTNET_RPC_URL'] ?? 'https://bsc-testnet-dataseed.bnbchain.org';
const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e' as const;
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
const pub = createPublicClient({ chain: bscTestnet, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: bscTestnet, transport: http(RPC) });

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
 * The same shape every other registration on this chain uses: a data: URI
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
  registrations: [{ agentId: Number(predicted), agentRegistry: `eip155:97:${REGISTRY}` }],
  services: [{ endpoint: `${WEB}/.well-known/agent-card.json`, name: 'A2A', version: '0.3.0' }],
  type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
};

const tokenUri = `data:application/json;base64,${Buffer.from(JSON.stringify(registration)).toString('base64')}`;
console.log(`tokenURI is ${tokenUri.length} bytes`);

const balance = await pub.getBalance({ address: account.address });
console.log(`signer ${account.address} holds ${balance} wei`);

const gas = await pub.estimateGas({
  account: account.address,
  to: REGISTRY,
  data: (await import('viem')).encodeFunctionData({
    abi: REGISTRY_ABI,
    functionName: 'register',
    args: [tokenUri],
  }),
});
console.log(`estimated gas ${gas}`);

const hash = await wallet.writeContract({
  address: REGISTRY,
  abi: REGISTRY_ABI,
  functionName: 'register',
  args: [tokenUri],
});
console.log(`sent ${hash}`);

const receipt = await pub.waitForTransactionReceipt({ hash });
console.log(`status ${receipt.status} in block ${receipt.blockNumber}`);

// Read the id back rather than trusting the prediction: another registration
// could have landed between the scan and this send, and a registration blob
// naming the wrong agentId is exactly the kind of quietly-wrong record this
// project keeps removing.
const minted = receipt.logs
  .filter((l) => l.address.toLowerCase() === REGISTRY.toLowerCase() && l.topics.length === 4)
  .map((l) => BigInt(l.topics[3] ?? '0x0'));
console.log(`minted token id(s): ${minted.map((m) => m.toString()).join(', ') || 'none found'}`);
if (minted[0] !== undefined && minted[0] !== predicted) {
  console.warn(
    `WARNING: predicted ${predicted} but minted ${minted[0]}; the registration blob names the ` +
      'wrong agentId and should be re-registered.',
  );
}
console.log(`https://testnet.bscscan.com/tx/${hash}`);
