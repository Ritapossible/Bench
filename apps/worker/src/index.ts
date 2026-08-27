import { buildAdapters } from '@bench/adapters';
import { loadConfig } from '@bench/config';
import { PgAuditionStore, PgCatalogRepository, createDb, runMigrations } from '@bench/db';
import { Indexer, ProbeAnchor, Prober } from '@bench/services';
import { Queue, Worker } from 'bullmq';
import { CADENCE_MS, QUEUE, redisOptionsFrom, repeatOpts } from './queues.js';

/**
 * Worker entrypoint. Hosts the Phase 1 services — indexer, prober, anchor — as
 * three queues on one process. Split them out only if one starves the others;
 * at catalog scale it is a timer loop with network waits, not a CPU problem.
 *
 * Boot order matters: config is validated first so a missing env var fails
 * here, loudly, rather than three hours into an audition backfill.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();

  // Migrations before anything opens a pool. The worker boots ahead of the web
  // app in every deployment ordering worth having, so this is the one process
  // that can be relied on to bring the schema forward; the advisory lock inside
  // makes it safe when several instances boot at once.
  await runMigrations(cfg.DATABASE_URL);

  const db = createDb(cfg.DATABASE_URL);
  const repo = new PgCatalogRepository(db);
  const audition = new PgAuditionStore(db);
  const adapters = buildAdapters(cfg);
  const redis = redisOptionsFrom(cfg.REDIS_URL);

  const indexer = new Indexer(adapters.registry, repo, {
    chain: cfg.BENCH_CHAIN,
    startBlock: BigInt(cfg.ERC8004_REGISTRY_START_BLOCK),
  });
  const prober = new Prober(adapters.probe, repo);
  const anchor = new ProbeAnchor(adapters.registry, repo);

  console.log(
    `[bench:worker] chain=${cfg.BENCH_CHAIN} wallet=${cfg.BENCH_WALLET_PROVIDER} ` +
      `egress_budget=$${cfg.SHADOW_EGRESS_BUDGET_USD}/run forks<=${cfg.SHADOW_MAX_CONCURRENT_FORKS}`,
  );

  const queues = [
    new Queue(QUEUE.indexer, redis),
    new Queue(QUEUE.prober, redis),
    new Queue(QUEUE.anchor, redis),
  ];

  const workers = [
    new Worker(
      QUEUE.indexer,
      async () => {
        const head = await adapters.registry.headBlock();
        const r = await indexer.tick(head);
        console.log(
          `[bench:indexer] blocks ${r.fromBlock}-${r.toBlock} discovered=${r.discovered} ` +
            `cards ok=${r.cardsResolved} failed=${r.cardsFailed}`,
        );

        // Append the density measurement each tick. The registry health page
        // plots this as a trend, and a trend only exists if someone writes the
        // points down as they happen - it cannot be reconstructed later from a
        // catalog that only remembers its current state.
        await audition.recordStats(await repo.stats(cfg.BENCH_CHAIN));
      },
      // concurrency 1: two indexer ticks would race on the same checkpoint.
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.prober,
      async () => {
        const r = await prober.tick();
        if (r.probed > 0) {
          console.log(
            `[bench:prober] probed=${r.probed} reachable=${r.reachable} ` +
              `conformant=${r.conformant} errors=${r.failed}`,
          );
        }
      },
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.anchor,
      async () => {
        const r = await anchor.tick();
        console.log(
          r.anchored
            ? `[bench:anchor] ${r.probeCount} probes → ${r.digest} tx=${r.txHash}`
            : `[bench:anchor] holding, ${r.pending} probes pending`,
        );
      },
      { ...redis, concurrency: 1 },
    ),
  ];

  for (const w of workers) {
    // Without this, a throwing job prints an unhandled rejection and the
    // process keeps running as though the tick had succeeded.
    w.on('failed', (job, err) => {
      console.error(`[bench:worker] ${w.name} job ${job?.id ?? '?'} failed:`, err);
    });
  }

  // Repeatable jobs are idempotent by repeat key, so re-adding them on every
  // boot is the intended way to keep the schedule in sync with the code.
  const [indexQ, probeQ, anchorQ] = queues as [Queue, Queue, Queue];
  await indexQ.add('tick', {}, repeatOpts(CADENCE_MS.indexer));
  await probeQ.add('tick', {}, repeatOpts(CADENCE_MS.prober));
  await anchorQ.add('tick', {}, repeatOpts(CADENCE_MS.anchor));

  console.log(
    `[bench:worker] queues up — indexer/${CADENCE_MS.indexer}ms ` +
      `prober/${CADENCE_MS.prober}ms anchor/${CADENCE_MS.anchor}ms`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bench:worker] ${signal} — draining`);
    // Workers first: stop taking new jobs and let in-flight ticks finish
    // before the queues (and their Redis connections) go away.
    await Promise.all(workers.map((w) => w.close()));
    await Promise.all(queues.map((q) => q.close()));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[bench:worker] fatal', err);
  process.exit(1);
});
