/**
 * Measure the live share of the BSC *mainnet* ERC-8004 registry, by sampling.
 *
 *     BENCH_MAINNET_REGISTRY=0x8004a169… npx tsx scripts/mainnet-triage.mts [sampleSize]
 *
 * Why sampling rather than a full sweep. The mainnet registry holds ~343,000
 * tokens, so enumerating it costs ~686,000 contract reads and probing every
 * resolvable endpoint at the six-hour freshness rule needs ~670 probes/minute
 * sustained. Neither is a thing to do before knowing whether the answer is
 * interesting. A uniform random sample of a few thousand ids answers "what
 * share of this registry is actually live" to within about a percentage point,
 * for four orders of magnitude less work.
 *
 * The read path is the production one - the same CardResolver and the same
 * HttpProbeClient the prober uses - so the number this prints is comparable
 * with the testnet figure on /registry rather than a second, kinder
 * definition of "live".
 *
 * One probe per agent, where the catalog requires three inside six hours. So
 * `reachable` here is an upper bound on the live share: an endpoint that
 * answers once may still fail the uptime rule. Stated rather than smoothed
 * over, because the whole point of the number is that it is honest.
 */
import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { bsc } from 'viem/chains';
import { CardResolver } from '../packages/adapters/src/catalog/card-resolver.js';
import { HttpProbeClient } from '../packages/adapters/src/probe/http-probe.js';
import type { AgentEndpoint } from '../packages/core/src/types/agent.js';

const REGISTRY = (process.env['BENCH_MAINNET_REGISTRY'] ??
  '0x8004a169fb4a3325136eb29fa0ceb6d2e539a432') as Address;
const RPC = process.env['BSC_MAINNET_RPC_URL'] ?? 'https://bsc-dataseed.bnbchain.org';
const SAMPLE = Number(process.argv[2] ?? 1_000);
const CARD_CONCURRENCY = 12;
const PROBE_CONCURRENCY = 12;

const ABI = parseAbi([
  'function ownerOf(uint256) view returns (address)',
  'function tokenURI(uint256) view returns (string)',
]);

const pub = createPublicClient({
  chain: bsc,
  transport: http(RPC, { batch: { wait: 20 } }),
  // Multicall3 is deployed at the canonical address on BSC, so a page of reads
  // costs one request instead of one per token.
  batch: { multicall: { wait: 20, batchSize: 2_048 } },
});

const exists = async (id: bigint): Promise<boolean> => {
  try {
    await pub.readContract({ address: REGISTRY, abi: ABI, functionName: 'ownerOf', args: [id] });
    return true;
  } catch {
    return false;
  }
};

/** No totalSupply on this contract, so the boundary is searched for. */
async function highestTokenId(): Promise<bigint> {
  let lo = 1n;
  let hi = 1n;
  while (await exists(hi)) {
    lo = hi;
    hi *= 2n;
    if (hi > 1n << 26n) break;
  }
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (await exists(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Wilson score interval.
 *
 * Not the textbook normal approximation: at the rates this is measuring - one
 * percent of a few thousand - the normal interval runs off the end of the
 * scale and reports a negative lower bound, which would be a confident
 * statement about an impossible number.
 */
function wilson(hits: number, n: number, z = 1.96): readonly [number, number] {
  if (n === 0) return [0, 0];
  const p = hits / n;
  const d = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const spread = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (centre - spread) / d), Math.min(1, (centre + spread) / d)];
}

async function pooled<T>(items: readonly T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const item = items[i++];
        if (item !== undefined) await fn(item);
      }
    }),
  );
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

const top = process.env['BENCH_MAINNET_TOP_ID'];
const highest = top === undefined ? await highestTokenId() : BigInt(top);
console.log(`registry ${REGISTRY} on BSC mainnet, highest token id ${highest.toLocaleString()}`);
console.log(`sampling ${SAMPLE.toLocaleString()} ids uniformly at random\n`);

const ids = new Set<bigint>();
while (ids.size < Math.min(SAMPLE, Number(highest))) {
  ids.add(BigInt(1 + Math.floor(Math.random() * Number(highest))));
}
const sample = [...ids];

const counts = {
  sampled: sample.length,
  minted: 0,
  cardResolved: 0,
  hasEndpoint: 0,
  reachable: 0,
  conformant: 0,
};
const cardErrors = new Map<string, number>();
const noEndpoint = new Map<string, number>();
const probeErrors = new Map<string, number>();
const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/**
 * Read in chunks, and count read failures separately from unminted ids.
 *
 * Firing all of them at once got the whole sample rate-limited by the public
 * node, and the catch below reported every one of them as "not minted" - a
 * clean 0% that looked like a finding rather than a throttle. A read that
 * failed is not a fact about the token.
 */
const CHUNK = 40;
const uris: { id: bigint; uri: string | null }[] = [];
let readFailures = 0;
for (let i = 0; i < sample.length; i += CHUNK) {
  const chunk = sample.slice(i, i + CHUNK);
  const got = await Promise.all(
    chunk.map(async (id) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return {
            id,
            uri: await pub.readContract({
              address: REGISTRY,
              abi: ABI,
              functionName: 'tokenURI',
              args: [id],
            }),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // A token that was never minted reverts; anything else is the node
          // refusing to answer, and retrying is the right response to it.
          if (/revert|nonexistent|ERC721/i.test(msg)) return { id, uri: null };
          if (attempt === 2) {
            readFailures += 1;
            bump(cardErrors, `tokenURI read failed: ${msg.split('\n')[0]?.slice(0, 50) ?? ''}`);
            return { id, uri: null };
          }
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      return { id, uri: null };
    }),
  );
  uris.push(...got);
  process.stdout.write(`\r  read ${uris.length}/${sample.length}`);
  await new Promise((r) => setTimeout(r, 120));
}
process.stdout.write('\n');
if (readFailures > 0) {
  console.log(
    `WARNING: ${readFailures} tokenURI reads failed outright and are counted as unminted`,
  );
}
counts.minted = uris.filter((u) => u.uri !== null).length;
console.log(`minted: ${counts.minted}/${counts.sampled}`);

const resolver = new CardResolver({ timeoutMs: 8_000 });
const probe = new HttpProbeClient({ timeoutMs: 8_000 });
const endpoints: { id: bigint; endpoint: AgentEndpoint }[] = [];

await pooled(uris, CARD_CONCURRENCY, async ({ id, uri }) => {
  if (uri === null) return;
  try {
    const card = await resolver.resolve(uri);
    counts.cardResolved += 1;
    const ep = card.endpoints[0];
    if (ep === undefined) {
      // Not a resolution failure: the card parsed, and simply names no
      // machine-callable service. On this registry that is the dominant
      // shape, so it gets its own line rather than polluting the error list.
      bump(noEndpoint, 'card resolves but declares no endpoint');
      return;
    }
    counts.hasEndpoint += 1;
    endpoints.push({ id, endpoint: ep });
  } catch (err) {
    bump(cardErrors, (err instanceof Error ? err.message : String(err)).slice(0, 60));
  }
});
console.log(`cards resolved: ${counts.cardResolved}, with an endpoint: ${counts.hasEndpoint}`);
console.log(`probing ${endpoints.length} endpoints…\n`);

await pooled(endpoints, PROBE_CONCURRENCY, async ({ id, endpoint }) => {
  const r = await probe.probe({ chain: 'bsc-mainnet', tokenId: id }, endpoint);
  if (r.reachable) counts.reachable += 1;
  if (r.conformant) counts.conformant += 1;
  if (!r.reachable || !r.conformant) bump(probeErrors, (r.error ?? 'no reason').slice(0, 60));
});

const n = counts.sampled;
const row = (label: string, hits: number) => {
  const [lo, hi] = wilson(hits, n);
  const est = Math.round((hits / n) * Number(highest));
  console.log(
    `${label.padEnd(26)} ${String(hits).padStart(5)}/${n}  ${pct(hits / n).padStart(7)}  ` +
      `[${pct(lo)} - ${pct(hi)}]  ≈ ${est.toLocaleString()} of ${Number(highest).toLocaleString()}`,
  );
};

console.log('\n' + '='.repeat(92));
console.log(
  'BSC MAINNET REGISTRY TRIAGE'.padEnd(26) + ' sample   share    95% interval        extrapolated',
);
console.log('='.repeat(92));
row('minted', counts.minted);
row('card resolves', counts.cardResolved);
row('declares an endpoint', counts.hasEndpoint);
row('endpoint answered once', counts.reachable);
row('spoke its own protocol', counts.conformant);
console.log('='.repeat(92));
console.log(
  '\n"spoke its own protocol" is one probe, not the three inside six hours the catalog\n' +
    'requires, so it is an upper bound on the verified-live share.\n',
);

const show = (title: string, m: Map<string, number>) => {
  if (m.size === 0) return;
  console.log(title);
  for (const [reason, count] of [...m].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${String(count).padStart(4)}x ${reason}`);
  }
  console.log();
};
show('resolved cards with nothing to call:', noEndpoint);
show('why cards did not resolve:', cardErrors);
show('why endpoints did not answer:', probeErrors);
