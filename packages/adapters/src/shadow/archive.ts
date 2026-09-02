import { BenchError, type ChainName } from '@bench/core';
import { createPublicClient, http } from 'viem';
import { bsc, bscTestnet } from 'viem/chains';
import { startAnvil } from './anvil-process.js';

/**
 * Reads the archive endpoint auditions fork from, and proves it is the right
 * one before anything relies on it.
 *
 * Both checks exist because both failure modes are silent. An endpoint serving
 * the wrong chain forks a chain with no liquidity and produces runs that look
 * like agent failures. A pruned endpoint answers `eth_getCode` at depth - dRPC's
 * public pool does - while refusing `eth_getStorageAt` at the same block, which
 * is the call a fork actually depends on, so the check has to be the second
 * one.
 */
export interface ArchiveStatus {
  readonly head: bigint;
  readonly chainId: number;
}

const CHAIN_IDS: Record<ChainName, number> = {
  'bsc-mainnet': bsc.id,
  'bsc-testnet': bscTestnet.id,
};

/** A contract that exists on both chains, used only as a storage-read target. */
const PROBE_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

export async function checkArchiveRpc(
  rpcUrl: string,
  expected: ChainName,
  atDepth: bigint,
): Promise<ArchiveStatus> {
  const client = createPublicClient({
    chain: expected === 'bsc-mainnet' ? bsc : bscTestnet,
    transport: http(rpcUrl, { timeout: 20_000, retryCount: 1 }),
  });

  const chainId = await client.getChainId();
  if (chainId !== CHAIN_IDS[expected]) {
    throw new BenchError(
      'FORK_UNAVAILABLE',
      `BSC_ARCHIVE_RPC_URL serves chain ${chainId}, but SHADOW_FORK_CHAIN is ` +
        `${expected} (chain ${CHAIN_IDS[expected]}). Forking the wrong chain produces ` +
        `runs that fail for reasons having nothing to do with the agent.`,
    );
  }

  const head = await client.getBlockNumber();
  const at = head > atDepth ? head - atDepth : 0n;

  // The real archive test. Not eth_getCode: a pruned node can answer that from
  // the code store without the state trie, which is how an endpoint passes a
  // depth check and then fails every fork.
  try {
    await client.getStorageAt({
      address: '0x55d398326f99059fF775485246999027B3197955',
      slot: PROBE_SLOT,
      blockNumber: at,
    });
  } catch (err) {
    throw new BenchError(
      'FORK_UNAVAILABLE',
      `BSC_ARCHIVE_RPC_URL cannot serve state at block ${at} (${atDepth} behind head): ` +
        `${err instanceof Error ? err.message : String(err)}. Auditions replay historical ` +
        `state, which a pruned node cannot do.`,
      err,
    );
  }

  return { head, chainId };
}

/**
 * Everything an audition needs, checked before the queue is registered.
 *
 * The archive check alone was not enough, and the way it was not enough is the
 * point: a deployment reported `archive ok`, enabled the audition queue, and
 * then failed at the first fork because Foundry was installed in CI and nowhere
 * else. Validating the remote dependency while assuming the local one is the
 * same mistake in a different place, so the fork binary is proven the only way
 * that proves anything - by starting one.
 */
export interface AuditionPreflight extends ArchiveStatus {
  /** The fork block a window would pin, so the caller can log what it checked. */
  readonly probedBlock: bigint;
}

export async function checkAuditionPreconditions(
  rpcUrl: string,
  expected: ChainName,
  atDepth: bigint,
): Promise<AuditionPreflight> {
  const status = await checkArchiveRpc(rpcUrl, expected, atDepth);

  // No fork-url: this proves the binary runs and can bind a port, without
  // spending an archive request or waiting on a remote node at boot.
  let handle;
  try {
    handle = await startAnvil({});
  } catch (err) {
    throw new BenchError(
      'FORK_UNAVAILABLE',
      `auditions need Foundry's anvil on PATH and it could not be started: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      err,
    );
  }
  await handle.stop();

  return { ...status, probedBlock: status.head > atDepth ? status.head - atDepth : 0n };
}
