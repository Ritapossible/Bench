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
  /**
   * How long after finishing a pass before the walk starts over.
   *
   * Enumeration resumes from a cursor and stops at the end of the registry, so
   * an agent indexed once was never looked at again. Cards are mutable and the
   * parser is not final - when `inferCategory` was fixed so `rebalancing`
   * could be produced at all, every one of the 2,060 already-indexed agents
   * would have kept its old category forever. A parser fix that does not reach
   * the existing catalog is not a fix in production.
   */
  readonly resweepAfterMs?: number;
  /**
   * Walk the registry from its newest token id downward.
   *
   * See `recentFirstTick`. Off by default, because on a small registry the
   * order does not matter and ascending is simpler to reason about.
   */
  readonly recentFirst?: boolean;
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

export interface EnumerationTickResult {
  /** True when this tick rewound the cursor to start a fresh pass. */
  readonly resweeping: boolean;
  readonly fromTokenId: bigint;
  readonly lastTokenId: bigint;
  readonly discovered: number;
  readonly cardsResolved: number;
  readonly cardsFailed: number;
  readonly upserted: number;
  /** False when the walk stopped on its own limit and more remain. */
  readonly reachedEnd: boolean;
}

export interface IndexerTickResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly discovered: number;
  readonly cardsResolved: number;
  readonly cardsFailed: number;
  readonly upserted: number;
}

const DEFAULTS = {
  /**
   * Six hours. Long enough that Bench is not re-fetching strangers' cards on a
   * loop - a full pass costs about 700 HTTP fetches, the rest being inline
   * data: URIs - and short enough that a mutated card is not stale for a day.
   */
  resweepAfterMs: 6 * 60 * 60 * 1000,
  confirmations: 15n,
  batchSize: 500,
  cardConcurrency: 8,
} as const;

/**
 * How hard to walk a registry, by how big that registry actually is.
 *
 * These were one pair of numbers tuned for BSC testnet - 500 tokens a tick,
 * re-sweep every six hours - and they do not survive contact with mainnet,
 * which holds about 343,000 tokens against testnet's 2,400. At 500 a tick on a
 * five-minute cadence a full mainnet pass takes roughly 57 hours, and a
 * six-hour re-sweep timer rearms the moment it finishes. The indexer would
 * spend its entire life rewriting every row in the registry: about 170 MB a
 * pass, back to back, which is what exhausted a 5 GB monthly transfer
 * allowance and took the site down with it.
 *
 * Neither number is about taste. The batch is sized so a first pass finishes
 * in hours rather than days, and the re-sweep interval so re-reading a
 * quarter-million strangers' cards is a monthly event rather than a permanent
 * background load. Tokens are immutable once minted except for `tokenURI`, and
 * the tail-walk picks up new registrations - about 2,000 a day on mainnet -
 * within one tick either way.
 *
 *   bsc-mainnet   2,000/tick x 5 min  -> ~343,000 tokens in ~14 hours
 *   bsc-testnet     500/tick x 5 min  ->   ~2,400 tokens in ~25 minutes
 */
export function indexerProfileFor(chain: string): {
  readonly batchSize: number;
  readonly resweepAfterMs: number;
} {
  return chain === 'bsc-mainnet'
    ? { batchSize: 2_000, resweepAfterMs: 30 * 24 * 60 * 60 * 1000 }
    : { batchSize: 500, resweepAfterMs: 6 * 60 * 60 * 1000 };
}

export class Indexer {
  /** Whether this process has refreshed the top of the registry yet. */
  #refreshedTop = false;

  /**
   * When the last full pass began, in this process.
   *
   * Held in memory rather than persisted, and that is the useful part: a
   * restart forgets it, so the first pass after a deploy always re-sweeps.
   * A deploy is exactly when the parser may have changed, which is exactly
   * when every existing card needs reading again.
   */
  #lastSweepAt: number | null = null;

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
   * Rewind the cursor to zero when a pass has finished and enough time has
   * passed, so the next tick re-reads the whole registry.
   *
   * Only when the walk is idle - it reached the end and advanced nothing.
   * Rewinding mid-pass would re-read the front of the registry forever and
   * never reach the back. Note that "idle" is not "found no agents": the walk
   * deliberately re-reads the token it starts on, so a caught-up tick returns
   * one agent every time and the empty case only happens on an empty registry.
   * Returns whether it rewound, so the caller can say so rather than leaving a
   * sudden jump back to token 0 looking like the indexer lost its place.
   */
  private async maybeRewind(idle: boolean, fromTokenId: bigint): Promise<boolean> {
    if (!idle) return false;
    // Nothing behind the cursor means nothing to re-read - an empty registry,
    // or a first boot. Writing a checkpoint out of that would invent state.
    if (fromTokenId === 0n) return false;
    const now = Date.now();
    const due =
      this.#lastSweepAt === null ||
      now - this.#lastSweepAt >= (this.opts.resweepAfterMs ?? DEFAULTS.resweepAfterMs);
    if (!due) return false;
    await this.repo.setTokenCursor(this.opts.chain, 0n);
    this.#lastSweepAt = now;
    return true;
  }

  /**
   * ============================================================================
   * Index the newest end of the registry first.
   * ============================================================================
   *
   * Walking from token zero is the obvious order and the wrong one for a
   * registry this size. Measured against BSC mainnet: of the oldest 28,000
   * registrations, 1.27% declare a callable endpoint and none of 1,500 sampled
   * answered their own protocol, while registry-wide the same script measures
   * 11.40% and 0.45%. So an ascending walk spends its first thirteen hours
   * ingesting the deadest slice there is, and publishes a catalog of it.
   *
   * Descending costs exactly the same total work and puts the useful agents in
   * front. The cursor is the same column, reinterpreted as a low-water mark:
   * the lowest id indexed so far.
   *
   * **The first tick after a boot always re-reads the top.** New registrations
   * arrive above the head - about two thousand a day here - so the newest batch
   * is the one most worth refreshing, and a restart should not have to reach
   * the bottom before it notices them. It also makes the switch from an
   * ascending deployment self-healing: whatever id the old walk left behind is
   * overwritten with the real head on the first tick, rather than being
   * mistaken for a descent already in progress.
   *
   * Reaching zero starts again from the head, which by then has moved.
   */
  async recentFirstTick(): Promise<EnumerationTickResult> {
    const head = await this.registry.headTokenId();
    const batch = BigInt(this.opts.batchSize ?? DEFAULTS.batchSize);
    const stored = (await this.repo.checkpoint(this.opts.chain))?.lastTokenId ?? null;

    const fromTop = !this.#refreshedTop || stored === null || stored <= 0n || stored > head;
    this.#refreshedTop = true;

    const to = fromTop ? head : stored - 1n;
    const rawFrom = to - batch + 1n;
    const from = rawFrom < 0n ? 0n : rawFrom;

    const discovered = await this.registry.readTokenRange(from, to);
    const withCards = await this.attachCards(discovered);
    const upserted = await this.repo.upsertAgents(withCards);
    // After the write, as everywhere else here: checkpointing first would turn
    // a failed upsert into a permanently skipped range.
    await this.repo.setTokenCursor(this.opts.chain, from);

    return {
      resweeping: fromTop && stored !== null && stored > 0n && stored <= head,
      // The descent has covered the whole registry when it lands on zero; the
      // next tick starts again from a head that has moved since.
      reachedEnd: from === 0n,
      fromTokenId: from,
      lastTokenId: to,
      discovered: discovered.length,
      cardsResolved: withCards.filter((r) => r.card !== null).length,
      cardsFailed: withCards.filter((r) => r.card === null).length,
      upserted,
    };
  }

  /**
   * One enumeration pass: walk token ids, resolve cards, upsert.
   *
   * The alternative to `tick`, not a supplement to it, and the only one that
   * works against a public node. Registration events are history and every free
   * BSC endpoint prunes it - about eleven hours on the best of them - so a log
   * scan can reach this month and nothing before it. `ownerOf` and `tokenURI`
   * are current state, which a pruned node serves for any token regardless of
   * age, so the walk sees the whole registry.
   *
   * Resumes from the token cursor and stops when the registry ends. Once
   * caught up a tick costs a couple of calls, because new registrations take
   * the next id and there is nothing above it to find.
   */
  async enumerationTick(): Promise<EnumerationTickResult> {
    const checkpoint = await this.repo.checkpoint(this.opts.chain);
    // Re-read the last known id rather than starting past it. Enumeration is an
    // upsert by (chain, tokenId), so re-reading one agent is free, and it means
    // a card that failed to resolve last time gets another attempt.
    const fromTokenId =
      checkpoint?.lastTokenId === null || checkpoint?.lastTokenId === undefined
        ? 0n
        : checkpoint.lastTokenId;

    const { agents, lastTokenId, reachedEnd } = await this.registry.enumerateAgents({
      fromTokenId,
      limit: this.opts.batchSize ?? DEFAULTS.batchSize,
    });

    if (agents.length === 0) {
      // The steady state once caught up: nothing above the cursor. This is
      // where a re-sweep gets armed, so the walk starts over instead of
      // idling on a catalog it will never look at again.
      return {
        resweeping: await this.maybeRewind(reachedEnd, fromTokenId),
        fromTokenId,
        lastTokenId: fromTokenId,
        discovered: 0,
        cardsResolved: 0,
        cardsFailed: 0,
        upserted: 0,
        reachedEnd,
      };
    }

    const withCards = await this.attachCards(agents);
    const upserted = await this.repo.upsertAgents(withCards);

    // Only after the write lands, for the same reason as the block cursor: a
    // cursor advanced past a failed upsert is a permanently skipped agent.
    await this.repo.setTokenCursor(this.opts.chain, lastTokenId);

    return {
      // Only when the walk made no forward progress - it re-read the token it
      // started on and found nothing above it. That is the idle steady state,
      // and it is the only safe moment to rewind: on a tick that did advance,
      // resetting the cursor in the same breath would make "advances the
      // cursor" untrue and could strand the tail of the registry.
      resweeping: await this.maybeRewind(reachedEnd && lastTokenId === fromTokenId, fromTokenId),
      fromTokenId,
      lastTokenId,
      discovered: agents.length,
      cardsResolved: withCards.filter((r) => r.card !== null).length,
      cardsFailed: withCards.filter((r) => r.card === null).length,
      upserted,
      reachedEnd,
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
