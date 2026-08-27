import {
  BenchError,
  type AgentRecord,
  type CatalogRepository,
  type ChainName,
  type RegistryClient,
} from '@bench/core';
import { mapLimit } from './concurrency.js';

/**
 * The indexer: ERC-8004 registry events → `agents`, with each `tokenURI`
 * resolved to an agent card.
 *
 * Two properties matter more than throughput here.
 *
 * **Unresolvable cards are kept.** Roughly 96% of BSC registrations will fail
 * to produce a usable card. Those agents stay in the catalog with `card: null`
 * and a recorded reason. They are the denominator of the density figure Bench
 * publishes; silently dropping them would turn an honest "4% are real" into a
 * meaningless "100% of what we kept are real".
 *
 * **Re-running a range is safe.** The repository upserts by (chain, tokenId),
 * so a crash mid-batch costs a repeat, never a duplicate or a gap.
 */

export interface IndexerOptions {
  readonly chain: ChainName;
  /** Registry deployment block. Starting at 0 wastes hours on empty ranges. */
  readonly startBlock: bigint;
  /**
   * Blocks to stay behind head. BSC reorgs are shallow but real, and indexing
   * into an orphaned block writes an agent that never existed. Re-reading a
   * few blocks is cheap; a phantom agent in the catalog is not.
   */
  readonly confirmations?: bigint;
  /** Registry pages per tick. Bounds one tick's runtime and memory. */
  readonly batchSize?: number;
  /** Simultaneous card fetches against third-party hosts. */
  readonly cardConcurrency?: number;
}

export interface IndexerTickResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly discovered: number;
  readonly cardsResolved: number;
  readonly cardsFailed: number;
  readonly upserted: number;
}

const DEFAULTS = { confirmations: 15n, batchSize: 500, cardConcurrency: 8 } as const;

export class Indexer {
  constructor(
    private readonly registry: RegistryClient,
    private readonly repo: CatalogRepository,
    private readonly opts: IndexerOptions,
  ) {}

  /**
   * One pass. Returns a summary rather than logging so the caller decides
   * whether this is a log line, a metric, or a test assertion.
   */
  async tick(headBlock: bigint): Promise<IndexerTickResult> {
    const confirmations = this.opts.confirmations ?? DEFAULTS.confirmations;
    const safeHead = headBlock > confirmations ? headBlock - confirmations : 0n;

    const checkpoint = await this.repo.checkpoint(this.opts.chain);
    const fromBlock = checkpoint === null ? this.opts.startBlock : checkpoint.lastBlock + 1n;

    if (fromBlock > safeHead) {
      return {
        fromBlock,
        toBlock: safeHead,
        discovered: 0,
        cardsResolved: 0,
        cardsFailed: 0,
        upserted: 0,
      };
    }

    const discovered = await this.registry.listAgents({
      fromBlock,
      cursor: safeHead.toString(),
      limit: this.opts.batchSize ?? DEFAULTS.batchSize,
    });

    const withCards = await this.attachCards(discovered);
    const upserted = await this.repo.upsertAgents(withCards);

    // Advance only after the write lands. Checkpointing first would turn a
    // failed upsert into a permanently skipped block range.
    await this.repo.setCheckpoint(this.opts.chain, safeHead);

    return {
      fromBlock,
      toBlock: safeHead,
      discovered: discovered.length,
      cardsResolved: withCards.filter((r) => r.card !== null).length,
      cardsFailed: withCards.filter((r) => r.card === null).length,
      upserted,
    };
  }

  /**
   * Resolve each card, keeping the agent either way. Card hosts are slow,
   * flaky, and occasionally hostile, so a failure here is expected traffic —
   * it is recorded on the record and never allowed to reject the batch.
   */
  async attachCards(records: readonly AgentRecord[]): Promise<AgentRecord[]> {
    return mapLimit(
      records,
      this.opts.cardConcurrency ?? DEFAULTS.cardConcurrency,
      async (record) => {
        if (record.cardUri === '') {
          return { ...record, card: null, cardError: 'no tokenURI' };
        }
        try {
          return { ...record, card: await this.registry.resolveCard(record.cardUri) };
        } catch (err) {
          const reason = err instanceof BenchError ? err.message : String(err);
          return { ...record, card: null, cardError: reason };
        }
      },
    );
  }
}
