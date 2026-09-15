/**
 * The whole dispute lifecycle against a live Arbiter, printed as it happens.
 *
 *     node contracts/genlayer/tools/demo_cycle.mjs <arbiter> <0x-private-key>
 *
 * Exists because the interesting ruling cannot be produced through the UI, and
 * that is not a gap - it is the gate working. Bench refuses a transaction that
 * would break the mandate, and only admitted actions reach the published
 * record, so a dispute raised against a hire made in the app is dismissed or
 * goes unresolved. Never upheld, because nothing was breached.
 *
 * To show an upheld ruling you need a record that contains a breach. This uses
 * the one checked in at `contracts/genlayer/fixtures/demo-action-record.json`,
 * whose second action pays an address the mandate never allowlisted. Every
 * validator fetches that URL itself and replays it; nothing here is simulated.
 *
 * Needs a funded GenLayer key. On Studio Next the faucet is one JSON-RPC call:
 *   curl -X POST https://studio-next.genlayer.com/api -H 'content-type: application/json' \
 *     -d '{"jsonrpc":"2.0","id":1,"method":"sim_fundAccount","params":["<address>",1000000000000000000]}'
 */
import { randomBytes } from 'node:crypto';
import { GenLayerArbiter } from '../../../packages/adapters/dist/dispute/genlayer-arbiter.js';

const [address, privateKey] = process.argv.slice(2);
if (address === undefined || privateKey === undefined) {
  console.error('usage: demo_cycle.mjs <arbiter address> <0x private key>');
  process.exit(1);
}

const RECORD =
  'https://raw.githubusercontent.com/Ritapossible/Bench/main/contracts/genlayer/fixtures/demo-action-record.json';

const arbiter = new GenLayerArbiter({
  rpcUrl: process.env.GENLAYER_RPC_URL ?? 'https://studio-next.genlayer.com/api',
  address,
  chain: 'studio-next',
  privateKey,
  marketplaceDomain: 'bench-bnb.vercel.app',
  receiptRetries: 60,
  receiptIntervalMs: 5000,
});

/**
 * The terms the hire ran under.
 *
 * The allowlist holds one address. The record's second action pays a different
 * one, so the replay finds `contract-not-allowlisted` by arithmetic - and
 * `unseen-recipient` too, because the behavioural envelope never saw that
 * recipient either. Two independent bounds, one action, neither subsuming the
 * other.
 */
const TERMS = {
  mandate: {
    total_cap: '1000000000000000000',
    per_tx_cap: '500000000000000000',
    allowlist: ['0x3333333333333333333333333333333333333333'],
    expires_at: 1900000000,
    max_actions: 5,
    token: '0x5555555555555555555555555555555555555555',
  },
  envelope: {
    recipients: ['0x3333333333333333333333333333333333333333'],
    selectors: ['0x38ed1739'],
    max_single_value: '200000000000000000',
    max_cumulative_value: '600000000000000000',
    max_action_count: 3,
    sample_size: 3,
  },
  policy: {
    value_tolerance_bps: 5000,
    action_tolerance_bps: 10000,
    require_known_recipient: true,
    require_known_selector: true,
  },
};

const hireId = `h_demo_${Date.now().toString(36)}`;
const say = (n, s) => console.log(`\n[${n}] ${s}`);

say(1, 'register_hire   terms pinned by digest, before any dispute exists');
const { termsHash } = await arbiter.registerHire({
  hireId,
  agent: { chain: 'bsc-mainnet', tokenId: 346444n },
  // A per-browser client id, exactly as the app mints one. No key exists for
  // it anywhere, which is why the registrar files on its behalf below.
  client: `0x${randomBytes(20).toString('hex')}`,
  respondent: '0x7777777777777777777777777777777777777777',
  terms: TERMS,
  recordUrl: RECORD,
  marketplaceDomain: 'bench-bnb.vercel.app',
});
console.log(`    digest ${termsHash.slice(0, 24)}...`);
// Wait before the first read rather than polling straight away. The hire is
// not on chain for a few seconds, and asking too early makes the SDK log a
// failed `gen_call` - harmless, and it looks like a fault on camera.
await new Promise((r) => setTimeout(r, 5000));
for (let i = 0; i < 20 && (await arbiter.registration(hireId)) === null; i += 1) {
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`    pinned on chain: ${(await arbiter.registration(hireId)) !== null}`);

say(2, 'open_dispute    breach ground, 0.01 GEN bond');
const filed = await arbiter.openDispute({
  hireId,
  ground: 'breach',
  engagement: 'Rebalance the BNB/USDT position, touching only the allowlisted pool.',
  criteria: ['No funds left the allowlist.'],
  evidenceUrls: [],
  bond: 10_000_000_000_000_000n,
});
console.log(`    dispute ${filed.disputeId} ${filed.state}`);
console.log(`    claimant   ${filed.claimant}  (posted the bond)`);
console.log(`    on behalf  ${filed.onBehalfOf}  (the hire's client)`);
console.log(`    answer window closes ${filed.answerEndsAt.toISOString()}`);
console.log(`    evidence   ${JSON.stringify(await arbiter.independence(filed.disputeId))}`);

say(3, 'answer          only the respondent may, and this key is not it');
try {
  await arbiter.answer(filed.disputeId, ['https://bscscan.com/address/0x99']);
  console.log('    accepted');
} catch (err) {
  console.log(`    ${String(err?.message ?? err).slice(0, 100)}`);
}

say(4, 'adjudicate      refused until the answer window closes');
const waitMs = filed.answerEndsAt.getTime() + 5000 - Date.now();
if (waitMs > 10 * 60 * 1000) {
  console.log(`    ${Math.round(waitMs / 60000)} minutes to wait - deploy with a shorter`);
  console.log('    answer_period to see this in one run. See docs/DEMO.md section 5.');
  process.exit(0);
}
while (Date.now() < filed.answerEndsAt.getTime() + 5000) {
  await new Promise((r) => setTimeout(r, 5000));
  process.stdout.write('.');
}
console.log('');

const ruled = await arbiter.adjudicate(filed.disputeId, TERMS);
console.log(`    state    ${ruled.state}`);
console.log(`    resolved by ${ruled.verdict?.resolvedBy} (replay means zero model calls)`);
for (const c of ruled.verdict?.criteria ?? []) {
  console.log(`    criterion ${c.id}: ${c.status}, ${c.confidence}% confident`);
}
const findings = ruled.verdict?.observed?.findings ?? [];
for (const f of findings) console.log(`    finding  ${f.rule} at action ${f.seq}`);
console.log(`    evidence ${JSON.stringify(ruled.verdict?.evidence)}`);
