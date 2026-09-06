/**
 * ============================================================================
 * What a shadowed agent is allowed to ask the fork.
 * ============================================================================
 *
 * The interceptor decoded `eth_sendRawTransaction` and proxied everything else
 * through untouched. Everything else includes anvil's cheat codes. An agent
 * holding the run's gateway URL could call
 *
 *     anvil_setStorageAt(usdt, balanceSlot(me), 1e30)
 *
 * and post a six-figure delta without trading; or `anvil_setBalance`,
 * `evm_setNextBlockTimestamp` to jump a funding window, `anvil_mine` to skip
 * ahead of a liquidation. Every one of those writes the fork the outcome is
 * then read from, so the score is whatever the agent decided it should be.
 * That gateway is public by construction - it has to be, or no remote agent
 * could reach the fork at all - so the URL is not a secret and cannot be the
 * control.
 *
 * `eth_sendTransaction` was the same hole in a quieter form. The seeder leaves
 * the controller impersonated, so an unsigned send from that address executes
 * on anvil - moving the position without passing the safety gate and without
 * appearing in the agent's recorded actions. The run would show a delta and
 * "0 actions", which is precisely the shape of every misleading record this
 * project has spent two days removing.
 *
 * So: an allowlist, not a denylist. A denylist of cheat namespaces is a list of
 * the ones known today, and anvil adds methods; a list of what an agent
 * legitimately needs is short, stable, and fails closed when a node grows a new
 * capability.
 */

/**
 * Read-only chain access, plus the one write that is decoded and gated.
 *
 * Everything an agent needs to look at state, estimate, and submit a signed
 * transaction. Nothing that writes state by fiat.
 */
const ALLOWED = new Set([
  // Identity and chain shape.
  'eth_chainId',
  'net_version',
  'web3_clientVersion',
  'eth_syncing',
  'eth_protocolVersion',
  // Reading state.
  'eth_blockNumber',
  'eth_getBalance',
  'eth_getCode',
  'eth_getStorageAt',
  'eth_getTransactionCount',
  'eth_getBlockByNumber',
  'eth_getBlockByHash',
  'eth_getBlockTransactionCountByNumber',
  'eth_getBlockTransactionCountByHash',
  'eth_getTransactionByHash',
  'eth_getTransactionByBlockNumberAndIndex',
  'eth_getTransactionByBlockHashAndIndex',
  'eth_getTransactionReceipt',
  'eth_getLogs',
  'eth_getProof',
  // Simulating and pricing.
  'eth_call',
  'eth_estimateGas',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_createAccessList',
  // Filters: read-only, and an agent watching for its own logs needs them.
  'eth_newFilter',
  'eth_newBlockFilter',
  'eth_getFilterChanges',
  'eth_getFilterLogs',
  'eth_uninstallFilter',
  // The one write. Decoded, gated and recorded by the interceptor.
  'eth_sendRawTransaction',
]);

/**
 * Methods refused with a sentence rather than a bare error.
 *
 * Named individually because "unsupported" would send an agent looking for a
 * bug in its own client. These are the ones a competent agent might genuinely
 * reach for, and each refusal says what to do instead.
 */
const EXPLAINED: Readonly<Record<string, string>> = {
  eth_sendTransaction:
    'sign the transaction and use eth_sendRawTransaction. Unsigned sends bypass the audition ' +
    'record, so they would not count as anything you did.',
  eth_accounts: 'this node holds no keys for you; you were given one with the task.',
  eth_requestAccounts: 'this node holds no keys for you; you were given one with the task.',
  eth_sign: 'sign locally with the key you were given.',
  eth_signTransaction: 'sign locally with the key you were given.',
  personal_sign: 'sign locally with the key you were given.',
  eth_signTypedData_v4: 'sign locally with the key you were given.',
};

export interface RpcVerdict {
  readonly allowed: boolean;
  /** Present when refused. Safe to hand to the agent verbatim. */
  readonly reason?: string;
}

/** Whether a shadowed agent may call this method against the fork. */
export function rpcMethodVerdict(method: string): RpcVerdict {
  if (ALLOWED.has(method)) return { allowed: true };

  const explained = EXPLAINED[method];
  if (explained !== undefined) return { allowed: false, reason: explained };

  // The cheat namespaces, and anything else a node happens to expose. Named as
  // a category so the refusal is understandable without listing every method
  // anvil will ever add.
  return {
    allowed: false,
    reason:
      `${method} is not available during an audition. The fork accepts read-only calls and ` +
      'eth_sendRawTransaction; methods that write state directly would let a run set its own ' +
      'result.',
  };
}

/** Exported for the test that pins the allowlist against drift. */
export const ALLOWED_RPC_METHODS: readonly string[] = [...ALLOWED].sort();
