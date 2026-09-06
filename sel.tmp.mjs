// Which registration entrypoint does the deployed registry actually have?
// estimateGas from our signer: a wrong selector reverts, the right one prices.
import { createPublicClient, http, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import fs from 'node:fs';

const acct = privateKeyToAccount(fs.readFileSync(process.env.KEYFILE, 'utf8').trim());
const c = createPublicClient({ chain: bscTestnet, transport: http('https://bsc-testnet-dataseed.bnbchain.org') });
const REG = '0x8004a818bfb912233c491871b3d84c89a494bd9e';
const URI = 'data:application/json;base64,eyJuYW1lIjoidCJ9';

const candidates = [
  ['function register(string tokenURI) returns (uint256)', [URI]],
  ['function register(string tokenURI, address owner) returns (uint256)', [URI, acct.address]],
  ['function register(address owner, string tokenURI) returns (uint256)', [acct.address, URI]],
  ['function mint(string tokenURI) returns (uint256)', [URI]],
  ['function safeMint(address to, string uri) returns (uint256)', [acct.address, URI]],
  ['function registerAgent(string tokenURI) returns (uint256)', [URI]],
  ['function newAgent(string tokenURI) returns (uint256)', [URI]],
  ['function register(string agentDomain, address agentAddress) returns (uint256)', ['bench-bnb.vercel.app', acct.address]],
];

for (const [sig, args] of candidates) {
  const abi = parseAbi([sig]);
  const name = sig.slice(9, sig.indexOf('('));
  try {
    const data = encodeFunctionData({ abi, functionName: name, args });
    const gas = await c.estimateGas({ account: acct.address, to: REG, data });
    console.log(`OK    ${sig}  -> gas ${gas}`);
  } catch (e) {
    const m = String(e.shortMessage ?? e.message).split('\n')[0].slice(0, 90);
    console.log(`fail  ${sig.slice(9, 60).padEnd(52)} ${m}`);
  }
}
