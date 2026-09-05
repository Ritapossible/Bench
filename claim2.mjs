import { createPublicClient, createWalletClient, http, parseAbi, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bscTestnet } from 'viem/chains';
import fs from 'node:fs';
const acct=privateKeyToAccount(fs.readFileSync(process.env.KEYFILE,'utf8').trim());
const rpc='https://bsc-testnet-dataseed.bnbchain.org';
const pub=createPublicClient({chain:bscTestnet,transport:http(rpc)});
const w=createWalletClient({account:acct,chain:bscTestnet,transport:http(rpc)});
const F='0x86e9197CC0F76E4e4aaa7082180945196bBAb5D3', U='0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565';
const abi=parseAbi(['function requestTokens()','function allowedToWithdraw(address) view returns (bool)','function balanceOf(address) view returns (uint256)']);
const bal=async()=>formatUnits(await pub.readContract({address:U,abi,functionName:'balanceOf',args:[acct.address]}),18);
let n=0;
// ~3 hours of cycling; the faucet allows one claim per 30 minutes.
for(let i=0;i<180;i++){
  try{
    if(await pub.readContract({address:F,abi,functionName:'allowedToWithdraw',args:[acct.address]})){
      const h=await w.writeContract({address:F,abi,functionName:'requestTokens'});
      await pub.waitForTransactionReceipt({hash:h});
      n++; console.log(`[${new Date().toISOString().slice(11,19)}] claim ${n} -> $U ${await bal()}`);
    }
  }catch(e){ console.log('skip:', String(e.message).slice(0,70)); }
  await new Promise(r=>setTimeout(r,60_000));
}
console.log(`done: ${n} claims, $U ${await bal()}`);
