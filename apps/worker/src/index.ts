import { buildAdapters } from '@bench/adapters';
import { loadConfig } from '@bench/config';
import { createDb } from '@bench/db';

/**
 * Worker entrypoint. Hosts the indexer, prober, shadow runner, scorer, and
 * attestor as separate queues on one process for now; split them out only if
 * one starves the others.
 *
 * Boot order matters: config is validated first so a missing env var fails
 * here, loudly, rather than three hours into an audition backfill.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = createDb(cfg.DATABASE_URL);
  const adapters = buildAdapters(cfg);

  console.log(
    `[bench:worker] chain=${cfg.BENCH_CHAIN} wallet=${cfg.BENCH_WALLET_PROVIDER} ` +
      `egress_budget=$${cfg.SHADOW_EGRESS_BUDGET_USD}/run forks<=${cfg.SHADOW_MAX_CONCURRENT_FORKS}`,
  );

  // Phase 1: indexer + prober queues.
  // Phase 2: shadow runner consuming the audition queue.
  // Phase 3: scorer + attestor.
  void db;
  void adapters;

  console.log('[bench:worker] scaffold up — no queues registered yet (Phase 1)');
}

main().catch((err: unknown) => {
  console.error('[bench:worker] fatal', err);
  process.exit(1);
});
