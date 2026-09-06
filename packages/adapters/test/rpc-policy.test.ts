import { describe, expect, it } from 'vitest';
import { ALLOWED_RPC_METHODS, rpcMethodVerdict } from '../src/shadow/rpc-policy.js';

describe('rpcMethodVerdict', () => {
  it('refuses every way an agent could write the fork it is scored on', () => {
    /**
     * The hole this closes. The gateway that lets a remote agent reach the
     * fork is public by construction, and anvil's cheat codes were reachable
     * through it. Any of these lets a run decide its own result.
     */
    for (const method of [
      'anvil_setStorageAt',
      'anvil_setBalance',
      'anvil_impersonateAccount',
      'anvil_mine',
      'anvil_setCode',
      'hardhat_setBalance',
      'evm_setNextBlockTimestamp',
      'evm_increaseTime',
      'evm_snapshot',
      'evm_revert',
      'debug_traceCall',
      'miner_stop',
    ]) {
      expect(rpcMethodVerdict(method).allowed, method).toBe(false);
    }
  });

  it('fails closed on a method it has never heard of', () => {
    // An allowlist rather than a denylist, because anvil adds methods and a
    // list of today's cheat codes would quietly stop covering tomorrow's.
    expect(rpcMethodVerdict('anvil_someMethodInventedNextYear').allowed).toBe(false);
    expect(rpcMethodVerdict('').allowed).toBe(false);
  });

  it('refuses unsigned sends, and says why', () => {
    // The seeder leaves the controller impersonated, so this executed on anvil
    // - past the safety gate and outside the recorded actions. A run would
    // show a delta and "0 actions".
    const v = rpcMethodVerdict('eth_sendTransaction');
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('eth_sendRawTransaction');
  });

  it('tells an agent asking for keys where its key came from', () => {
    expect(rpcMethodVerdict('eth_accounts').reason).toContain('you were given one with the task');
    expect(rpcMethodVerdict('eth_sign').reason).toContain('sign locally');
  });

  it('leaves an agent everything it needs to trade', () => {
    for (const method of [
      'eth_chainId',
      'eth_blockNumber',
      'eth_getBalance',
      'eth_call',
      'eth_estimateGas',
      'eth_gasPrice',
      'eth_getTransactionCount',
      'eth_getTransactionReceipt',
      'eth_getLogs',
      'eth_sendRawTransaction',
    ]) {
      expect(rpcMethodVerdict(method).allowed, method).toBe(true);
    }
  });

  it('allows no method that writes state by fiat', () => {
    // A guard on the list itself: nothing in the allowlist may come from a
    // cheat namespace, however the list is edited later.
    for (const m of ALLOWED_RPC_METHODS) {
      expect(m, m).not.toMatch(/^(anvil|hardhat|evm|miner|personal|admin)_/);
    }
  });
});
