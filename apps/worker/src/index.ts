import {
  A2AShadowAgent,
  auditionWindows,
  buildAdapters,
  checkArchiveRpc,
  checkAuditionPreconditions,
  forkBlockFor,
  McpShadowAgent,
  FORK_LAG_BLOCKS,
} from '@bench/adapters';
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
import { startHealthServer } from './health.js';
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

  // `dns.lookup` is not async in the way the rest of Node is: it runs
  // getaddrinfo on the libuv threadpool, which is four threads by default. The
  // prober resolves hundreds of distinct hosts a tick, so those four threads
  // were the queue that exhausted every probe's timeout - reported, wrongly, as
  // the endpoints being slow. Raised in the start script because libuv reads
  // the variable when the pool is first used, which can precede this line.
  if (process.env['UV_THREADPOOL_SIZE'] === undefined) {
    console.warn(
      '[bench:worker] UV_THREADPOOL_SIZE is unset - DNS resolution will queue behind 4 threads',
    );
  }

  // Before the first network call, so a worker that then hangs on a bad
  // DATABASE_URL still answers "the process is up, no queue has ticked"
  // rather than nothing at all.
  const { heartbeat, server: health } = startHealthServer(Number(process.env['PORT'] ?? 8080));

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
  // Set when the archive check has already printed a specific reason, so the
  // generic "not set" line below does not contradict it.
  let archiveReasonReported = false;
  const archiveRpcUrl = await (async (): Promise<string | null> => {
    let url: string;
    try {
      url = requireArchiveRpc(cfg);
    } catch {
      return null;
    }
    // Configured is not the same as usable. An endpoint on the wrong chain, or
    // one that prunes state, fails at the first fork - hours later, as an agent
    // failure. Checked once here, where the message can name the cause.
    try {
      // Not just the archive: the fork binary too. Proving the remote
      // dependency and assuming the local one is what let a deployment report
      // "archive ok" and then fail every fork.
      const status = await checkAuditionPreconditions(url, cfg.SHADOW_FORK_CHAIN, FORK_LAG_BLOCKS);
      console.log(
        `[bench:worker] auditions ready - ${cfg.SHADOW_FORK_CHAIN} chain=${status.chainId} ` +
          `head=${status.head} fork@${status.probedBlock} anvil ok`,
      );
      return url;
    } catch (err) {
      console.error(
        `[bench:worker] auditions OFF - ${err instanceof Error ? err.message : String(err)}`,
      );
      archiveReasonReported = true;
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
              const name = agent.card?.name ?? `agent ${agent.id.tokenId}`;
              const endpoints = agent.card?.endpoints ?? [];

              // A2A first where an agent declares both: it has a verb for
              // "here is a task", where MCP has to be driven through its tools.
              const a2a = endpoints.find((e) => e.protocol === 'a2a');
              if (a2a !== undefined) {
                return new A2AShadowAgent({ id: agent.id, name, endpoint: a2a });
              }

              // MCP agents used to fall through to null and be counted as
              // skipped - about a third of the publicly-addressable endpoints
              // in the registry, excluded without anything saying so.
              const mcp = endpoints.find((e) => e.protocol === 'mcp');
              if (mcp !== undefined) {
                return new McpShadowAgent({ id: agent.id, name, endpoint: mcp });
              }
              return null;
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
  if (auditionService === null && !archiveReasonReported) {
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

  /**
   * What the tick in flight did, filled by the job body and read by the
   * `completed` handler - BullMQ hands the handler the job, not the value the
   * processor returned, and threading a return type through six queues to say
   * one sentence is not worth it.
   */
  const lastResult = new Map<string, string>();
  /**
   * Whether the tick in flight achieved anything, not merely whether it threw.
   * A queue that keeps completing without effect is the failure mode that cost
   * the most here, and it is invisible unless the job says so.
   */
  const didWork = new Map<string, boolean>();

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
        didWork.set(QUEUE.indexer, r.upserted > 0 || r.resweeping);
        lastResult.set(
          QUEUE.indexer,
          `tokens ${r.fromTokenId}-${r.lastTokenId} discovered=${r.discovered} ` +
            `cards=${r.cardsResolved}/${r.cardsResolved + r.cardsFailed}` +
            (r.resweeping ? ' re-sweeping' : ''),
        );
        console.log(
          `[bench:indexer] tokens ${r.fromTokenId}-${r.lastTokenId} discovered=${r.discovered} ` +
            `cards ok=${r.cardsResolved} failed=${r.cardsFailed} upserted=${r.upserted}` +
            (r.reachedEnd ? '' : ' (more to walk)') +
            // Otherwise the jump back to token 0 on the next tick reads as the
            // indexer having lost its place.
            (r.resweeping ? ' - re-sweeping from 0' : ''),
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
        didWork.set(QUEUE.prober, r.probed > 0);
        lastResult.set(
          QUEUE.prober,
          `probed=${r.probed} reachable=${r.reachable} conformant=${r.conformant}` +
            (r.reasons[0] === undefined ? '' : ` top=${r.reasons[0][1]}x ${r.reasons[0][0]}`),
        );
        if (r.probed > 0) {
          console.log(
            `[bench:prober] probed=${r.probed} reachable=${r.reachable} ` +
              `conformant=${r.conformant} errors=${r.failed}`,
          );
          // The counts say how bad it is; only the causes say what to do about
          // it. Printed whenever anything failed to reach a verdict, capped so
          // a fully dead catalog cannot flood the log.
          if (r.reasons.length > 0) {
            const top = r.reasons
              .slice(0, 5)
              .map(([reason, count]) => `${count}x ${reason}`)
              .join(' | ');
            console.log(`[bench:prober] unreachable because: ${top}`);
          }
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
        if (auditionService === null || archiveRpcUrl === null) return;
        // The fork block comes from the fork chain's head, not from
        // ERC8004_REGISTRY_START_BLOCK. Those are unrelated facts: where the
        // registry was deployed says nothing about which market window to
        // replay, and using it forked ~40 million blocks back - a year of
        // history, on a chain the registry is not even on.
        const status = await checkArchiveRpc(archiveRpcUrl, cfg.SHADOW_FORK_CHAIN, FORK_LAG_BLOCKS);
        const [spec] = auditionWindows({
          forkChain: cfg.SHADOW_FORK_CHAIN,
          forkBlock: forkBlockFor(status.head),
        });
        if (spec === undefined) {
          console.log(
            `[bench:audition] no window for ${cfg.SHADOW_FORK_CHAIN} - no seeder constants`,
          );
          return;
        }
        const r = await auditionService.tick(spec.window, spec.position);
        const summary =
          `window=${r.window} considered=${r.considered} auditioned=${r.auditioned} ` +
          `ok=${r.succeeded} failed=${r.failed} skipped=${r.skipped}`;
        didWork.set(QUEUE.audition, r.auditioned > 0);
        lastResult.set(QUEUE.audition, summary);
        console.log(`[bench:audition] ${summary}`);
      },
      // One at a time: each audition holds a forked chain per agent.
      { ...redis, concurrency: 1 },
    ),
    new Worker(
      QUEUE.scorer,
      async () => {
        // Driven by evidence, not by a page of the catalog. Taking the first
        // 500 rows ordered by token id meant the scorer could only ever see
        // tokens 0-499, while auditions pick from verified-live agents spread
        // across all 2,066 - so the one agent that did audition successfully,
        // at #1581, was never looked at and the catalog said "no auditions
        // yet" indefinitely.
        const scorable = await audition.agentsWithOutcomes(cfg.BENCH_CHAIN, 500);
        const r = await scorer.scoreAll(
          scorable.map((e) => ({ id: e.agent, category: e.category })),
        );
        didWork.set(QUEUE.scorer, r.scored > 0);
        lastResult.set(QUEUE.scorer, `scored=${r.scored} skipped=${r.skipped} thin=${r.thin}`);
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
        didWork.set(QUEUE.crossref, summary.checked > 0);
        lastResult.set(
          QUEUE.crossref,
          `${summary.status} checked=${summary.checked} confirmed=${summary.confirmed}`,
        );
        console.log(
          `[bench:crossref] ${summary.status} checked=${summary.checked} ` +
            `confirmed=${summary.confirmed} agreement=${(summary.agreementBps / 100).toFixed(1)}%`,
        );
      },
      { ...redis, concurrency: 1 },
    ),
  ];

  /**
   * Connection errors are throttled, and say which component and why.
   *
   * ioredis retries forever by design, and with six queues and six workers a
   * Redis that is briefly away produced twelve raw ECONNREFUSED stack traces
   * per retry - forty kilobytes of log in forty-five seconds, none of it
   * naming Redis, the queue, or what to do. Retrying is right; reprinting the
   * same fact hundreds of times is not, and it buries the line that matters.
   */
  const lastConnectionLog = new Map<string, number>();
  const CONNECTION_LOG_EVERY_MS = 30_000;
  const noteConnectionError = (component: string, err: Error): void => {
    const now = Date.now();
    const last = lastConnectionLog.get(component) ?? 0;
    if (now - last < CONNECTION_LOG_EVERY_MS) return;
    lastConnectionLog.set(component, now);
    console.error(
      `[bench:worker] ${component}: redis connection error (retrying) - ${err.message}`,
    );
  };

  for (const q of queues) {
    q.on('error', (err) => {
      noteConnectionError(`queue ${q.name}`, err);
    });
  }

  for (const w of workers) {
    w.on('error', (err) => {
      noteConnectionError(`worker ${w.name}`, err);
    });
    // Without this, a throwing job prints an unhandled rejection and the
    // process keeps running as though the tick had succeeded.
    w.on('failed', (job, err) => {
      heartbeat.fail(w.name, err instanceof Error ? err.message : String(err));
      console.error(`[bench:worker] ${w.name} job ${job?.id ?? '?'} failed:`, err);
    });
    w.on('completed', () => {
      heartbeat.mark(w.name, lastResult.get(w.name), didWork.get(w.name));
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
    health.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  console.error('[bench:worker] fatal', err);
  process.exit(1);
});
