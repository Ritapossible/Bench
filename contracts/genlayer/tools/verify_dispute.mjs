/**
 * Read a dispute back off the chain, to show the front end really wrote it.
 *
 *     node contracts/genlayer/tools/verify_dispute.mjs <arbiter address> [id]
 *
 * Read-only: no key, no gas, nothing to configure. That is the point - anyone
 * watching can run it against the same address and get the same answer, which
 * is the difference between demonstrating an integration and asserting one.
 *
 * The convincing part is the text. `engagement` and `criteria` come back word
 * for word as they were typed into the form, from a contract on a chain the
 * marketplace does not run. A screenshot of a form proves nothing; the same
 * sentence read out of GenLayer storage is hard to argue with.
 */
import { createClient } from 'genlayer-js';
import { studioDevnet } from 'genlayer-js/chains';

const [address, wanted] = process.argv.slice(2);
if (address === undefined) {
  console.error('usage: verify_dispute.mjs <arbiter address> [dispute id]');
  process.exit(1);
}

const client = createClient({
  chain: studioDevnet,
  endpoint: process.env.GENLAYER_RPC_URL ?? 'https://studio-next.genlayer.com/api',
});

const read = async (functionName, args = []) =>
  client.readContract({ address, functionName, args });

const plain = (v) => (v instanceof Map ? Object.fromEntries(v) : v);
const at = (seconds) => new Date(Number(seconds) * 1000).toISOString();

const total = Number(await read('total'));
console.log(`arbiter   ${address}`);
console.log(`chain     GenLayer Studio Next (61997)`);
console.log(`disputes  ${total}`);

if (total === 0) {
  console.log('\nNothing filed yet. File one in the app, then run this again.');
  process.exit(0);
}

const id = wanted === undefined ? total - 1 : Number(wanted);
const d = plain(await read('dispute', [id]));

console.log(`\n--- dispute ${id} ---`);
console.log(`state        ${d.state}`);
console.log(`ground       ${d.ground}`);
console.log(`opened       ${at(d.opened_at)}`);
console.log(`answer ends  ${at(d.answer_end)}`);
console.log(`bond         ${Number(d.bond) / 1e18} GEN`);
console.log(`claimant     ${d.claimant}   (posted the bond)`);
console.log(`on behalf of ${d.on_behalf_of}   (the hire's client)`);
console.log(`respondent   ${d.respondent}`);

// The text typed into the form, read back out of contract storage.
console.log(`\nengagement   ${d.engagement}`);
console.log('criteria');
for (const [i, c] of (d.criteria ?? []).entries()) console.log(`  ${i + 1}. ${c}`);

console.log('\nevidence, and who each source belongs to');
const classes = d.source_class ?? [];
for (const [i, url] of (d.sources ?? []).entries()) {
  console.log(`  [${classes[i] ?? 'unclassified'}] ${url}`);
}

const tally = plain(await read('evidence_independence', [id]));
console.log(`\ntally        ${JSON.stringify(tally)}`);

if (String(d.verdict ?? '') === '') {
  console.log('\nNo verdict yet. Nobody may rule until the answer window closes.');
} else {
  console.log('\nverdict');
  console.log(JSON.stringify(JSON.parse(d.verdict), null, 2));
}
