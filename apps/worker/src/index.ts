import { A2AShadowAgent, auditionWindows, buildAdapters } from '@bench/adapters';
import { loadConfig, requireArchiveRpc } from '@bench/config';
import {
  PgAuditionStore,
  PgCatalogRepository,
  createDb,
  migrationUrl,
  runMigrations,
} from '@bench/db';
import {
  AuditionRunner,
  AuditionService,
  Indexer,
  ProbeAnchor,
  Prober,
  Scorer,
  summarizeAgreementFor,
} from '@bench/services';
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
  // The direct connection, never the pooled one - see migrationUrl.
  await runMigrations(migrationUrl() ?? cfg.DATABASE_URL);

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
  const scorer = new Scorer(audition);

  /**
   * Auditions need an archive node. Rather than refusing to boot - which used
   * to happen, and grounded a worker whose indexing and probing were perfectly
   * able to run - the queue is registered only when one is configured, and the
   * absence is stated once at startup.
   */
  const archiveRpcUrl = (() => {
    try {
      return requireArchiveRpc(cfg);
    } catch {
      return null;
    }
  })();

  const auditionService =
    archiveRpcUrl === null
      ? null
      : new AuditionService(
          {
            forks: adapters.fork,
            catalog: repo,
            store: audition,
            runner: new AuditionRunner({ forks: adapters.fork, egress: adapters.egress }),
            // Only agents with a probeable A2A endpoint can be driven. Anything
            // else returns null and is skipped rather than failed - it was never
            // auditionable, which is a different fact from having failed.
            agentFor: ({ agent }) => {
              const a2a = agent.card?.endpoints.find((e) => e.protocol === 'a2a');
              if (a2a === undefined) return null;
              return new A2AShadowAgent({
                id: agent.id,
                name: agent.card?.name ?? `agent ${agent.id.tokenId}`,
                endpoint: a2a,
              });
            },
          },
          { chain: cfg.BENCH_CHAIN, archiveRpcUrl },
        );
  const anchor = new ProbeAnchor(adapters.registry, repo);

  /**
   * Anchoring needs a funded signer and a target contract. Without them
   * `anchorProbeDigest` throws, and the queue was registering regardless -
   * failing every fifteen minutes forever while two pages claimed in present
   * tense that probes were anchored. Gated here, and the UI reads the same
   * truth from whether an anchor row exists.
   */
  const anchoringConfigured =
    cfg.BENCH_SIGNER_PRIVATE_KEY !== undefined && cfg.ERC8004_VALIDATION_REGISTRY !== undefined;

  console.log(
    `[bench:worker] chain=${cfg.BENCH_CHAIN} wallet=${cfg.BENCH_WALLET_PROVIDER} ` +
      `egress_budget=$${cfg.SHADOW_EGRESS_BUDGET_USD}/run forks<=${cfg.SHADOW_MAX_CONCURRENT_FORKS}`,
  );
  // Say what is off and why, once, rather than leaving it to be inferred from
  // a queue that never logs.
  if (auditionService === null) {
    console.log('[bench:worker] auditions OFF - BSC_ARCHIVE_RPC_URL is not set');
  }
  if (!anchoringConfigured) {
    console.log(
      '[bench:worker] probe anchoring OFF - needs BENCH_SIGNER_PRIVATE_KEY and ERC8004_VALIDATION_REGISTRY',
    );
  }
  if (adapters.egress === undefined || cfg.SHADOW_EGRESS_ALLOWLIST.length === 0) {
    console.log(
      '[bench:worker] egress allowlist is empty - shadowed agents get no outbound network',
    );
  }

  const queues = [
    new Queue(QUEUE.indexer, redis),
    new Queue(QUEUE.prober, redis),
    new Queue(QUEUE.anchor, redis),
    new Queue(QUEUE.audition, redis),
    new Queue(QUEUE.scorer, redis),
    new Queue(QUEUE.crossref, redis),
  ];

  const workers = [
    new Worker(
      QUEUE.indexer,
      async () => {
        // Enumeration, not log scanning. Registration events are history and
        // every free BSC endpoint prunes it, so a log scan reaches this month
        // and nothing before it; ownerOf and tokenURI are current state and
        // reach the whole registry. See Indexer.enumerationTick.
        const r = await indexer.enumerationTick();
        console.log(
          `[bench:indexer] tokens ${r.fromTokenId}-${r.lastTokenId} discovered=${r.discovered} ` +
            `cards ok=${r.cardsResolved} failed=${r.cardsFailed} upserted=${r.upserted}` +
            (r.reachedEnd ? '' : ' (more to walk)'),
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
        if (!anchoringConfigured) return;
        const r = await anchor.tick();
        console.log(
          r.anchored
            ? `[bench:anchor] ${r.probeCount} probes → ${r.digest} tx=${r.txHash}`
            : `[bench:anchor] holding, ${r.pending} probes pending`,
        );
      },
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.audition,
      async () => {
        if (auditionService === null) return;
        const [spec] = auditionWindows({ forkBlock: BigInt(cfg.ERC8004_REGISTRY_START_BLOCK) });
        if (spec === undefined) return;
        const r = await auditionService.tick(spec.window, spec.position);
        console.log(
          `[bench:audition] window=${r.window} auditioned=${r.auditioned} ` +
            `ok=${r.succeeded} failed=${r.failed} skipped=${r.skipped}`,
        );
      },
      // One at a time: each audition holds a forked chain per agent.
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.scorer,
      async () => {
        const page = await repo.query({ chain: cfg.BENCH_CHAIN, limit: 500 });
        const r = await scorer.scoreAll(
          page.entries.map((e) => ({
            id: e.record.id,
            category: e.record.card?.category ?? 'other',
          })),
        );
        console.log(
          `[bench:scorer] scored=${r.scored} skipped=${r.skipped} (no outcomes) thin=${r.thin}`,
        );
      },
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.crossref,
      async () => {
        // One upstream call per agent, paced. Belongs here and never in a page
        // render: doing it per request made /registry a forty-second page.
        const summary = await summarizeAgreementFor(adapters.crossRef, repo, cfg.BENCH_CHAIN, 200);
        await audition.recordCrossReference(cfg.BENCH_CHAIN, summary);
        console.log(
          `[bench:crossref] ${summary.status} checked=${summary.checked} ` +
            `confirmed=${summary.confirmed} agreement=${(summary.agreementBps / 100).toFixed(1)}%`,
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
  const [indexQ, probeQ, anchorQ, auditionQ, scorerQ, crossrefQ] = queues as [
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
    Queue,
  ];
  await indexQ.add('tick', {}, repeatOpts(CADENCE_MS.indexer));
  await probeQ.add('tick', {}, repeatOpts(CADENCE_MS.prober));
  if (anchoringConfigured) {
    await anchorQ.add('tick', {}, repeatOpts(CADENCE_MS.anchor));
  }
  await scorerQ.add('tick', {}, repeatOpts(CADENCE_MS.scorer));
  await crossrefQ.add('tick', {}, repeatOpts(CADENCE_MS.crossref));
  if (auditionService !== null) {
    await auditionQ.add('tick', {}, repeatOpts(CADENCE_MS.audition));
  }

  const registered = [
    `indexer/${CADENCE_MS.indexer}ms`,
    `prober/${CADENCE_MS.prober}ms`,
    `scorer/${CADENCE_MS.scorer}ms`,
    `crossref/${CADENCE_MS.crossref}ms`,
    ...(auditionService === null ? [] : [`audition/${CADENCE_MS.audition}ms`]),
    ...(anchoringConfigured ? [`anchor/${CADENCE_MS.anchor}ms`] : []),
  ];
  console.log(`[bench:worker] queues up - ${registered.join(' ')}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[bench:worker] ${signal} - draining`);
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
