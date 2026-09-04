import {
  A2AShadowAgent,
  auditionWindows,
  BscPositionReader,
  MIN_AUDITIONABLE_USD,
  mirrorPosition,
  reportWindowFor,
  buildAdapters,
  checkArchiveRpc,
  checkAuditionPreconditions,
  forkBlockFor,
  McpShadowAgent,
  FORK_LAG_BLOCKS,
} from '@bench/adapters';
import { loadConfig, requireArchiveRpc } from '@bench/config';
import { redactError } from '@bench/core';
import { RpcGateway } from '@bench/adapters';
import {
  PgAuditionStore,
  PgCatalogRepository,
  PgReportStore,
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
import { startHealthServer, type TickOutcome } from './health.js';
import { CADENCE_MS, QUEUE, redisOptionsFrom, repeatOpts } from './queues.js';

/**
 * How long raw probe results are kept.
 *
 * Thirty days. Liveness reads a rolling summary recomputed on every write and
 * `isVerifiedLive` looks at a short window, so older rows inform no answer -
 * and only rows already anchored are dropped, because that digest is a public
 * claim whose evidence has to outlive the sweep.
 */
const PROBE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

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
  /**
   * The audition gateway shares the worker's one public port.
   *
   * A container host publishes a single port. Binding a fresh public port per
   * fork works on a laptop and nowhere this runs, so `/rpc/<token>` is served
   * alongside `/health` and routed to the right loopback interceptor.
   */
  const rpcGateway = new RpcGateway({ publicBaseUrl: cfg.BENCH_PUBLIC_RPC_BASE_URL });

  /**
   * Set once auditions are known to be runnable, and read by /health.
   *
   * A closure rather than a value because the archive check happens after the
   * server is listening - the server has to answer "the process is up" while a
   * bad DATABASE_URL is still hanging.
   */
  let auditionsEnabled = false;

  const { heartbeat, server: health } = startHealthServer(
    Number(process.env['PORT'] ?? 8080),
    (req, res) => rpcGateway.handle(req, res),
    () => ({
      auditionRpcPubliclyRoutable: rpcGateway.publiclyRoutable,
      auditionsEnabled,
    }),
  );

  // Migrations before anything opens a pool. The worker boots ahead of the web
  // app in every deployment ordering worth having, so this is the one process
  // that can be relied on to bring the schema forward; the advisory lock inside
  // makes it safe when several instances boot at once.
  // The direct connection, never the pooled one - see migrationUrl.
  await runMigrations(migrationUrl() ?? cfg.DATABASE_URL);

  const db = createDb(cfg.DATABASE_URL);
  const repo = new PgCatalogRepository(db);
  const audition = new PgAuditionStore(db);
  const reportStore = new PgReportStore(db);

  /**
   * Positions are read from mainnet even when the catalog is testnet.
   *
   * Same reasoning as the web app's reader: the catalog answers which agents
   * are registered, and for judging that is testnet; a reader pasting their
   * address is asking about money they actually hold, which is on mainnet.
   */
  const positions = new BscPositionReader({
    chain: 'bsc-mainnet',
    rpcUrl: cfg.BSC_MAINNET_RPC_URL ?? 'https://bsc-dataseed.bnbchain.org',
  });
  const adapters = buildAdapters(cfg, rpcGateway);
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
  /**
   * The loudest line in this block, because it is the one that made the
   * product produce nothing while looking healthy.
   *
   * Without a public origin, an audition hands a registered agent a loopback
   * URL it cannot reach. The agent responds, the run completes, and the delta
   * is zero - not because the agent chose to do nothing, but because it was
   * never given a chain it could touch. Every score was that zero.
   */
  auditionsEnabled = auditionService !== null;

  if (auditionService !== null && !rpcGateway.publiclyRoutable) {
    console.warn(
      '[bench:worker] BENCH_PUBLIC_RPC_BASE_URL is not set - auditions will hand agents a ' +
        'loopback RPC they cannot reach, so every agent will measure exactly $0.00 whatever ' +
        "it would have done. Set it to this service's public origin.",
    );
  } else if (auditionService !== null) {
    console.log(`[bench:worker] audition RPC published at ${cfg.BENCH_PUBLIC_RPC_BASE_URL}/rpc/…`);
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
  const outcome = new Map<string, TickOutcome>();
  /** Round-robin cursor over the audition windows. See the audition worker. */
  let auditionTick = 0;

  const queues = [
    new Queue(QUEUE.indexer, redis),
    new Queue(QUEUE.prober, redis),
    new Queue(QUEUE.anchor, redis),
    new Queue(QUEUE.audition, redis),
    new Queue(QUEUE.scorer, redis),
    new Queue(QUEUE.crossref, redis),
    new Queue(QUEUE.report, redis),
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
        // A registry with no token minted since the last tick is the normal
        // steady state, not a stall.
        outcome.set(QUEUE.indexer, r.upserted > 0 || r.resweeping ? 'worked' : 'nothing-due');
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
        /**
         * Retention, on the queue that creates the rows.
         *
         * The prober writes up to two hundred rows a minute and nothing ever
         * removed one. Bounded per tick so a long-neglected table is worked
         * down over several passes rather than in one statement that locks it.
         */
        const pruned = await repo.pruneProbeResults(PROBE_RETENTION_MS, {
          // Only meaningful while anchoring runs. With it off, no row is ever
          // anchored, so keeping unanchored rows would retain everything.
          keepUnanchored: anchoringConfigured,
        });
        if (pruned > 0) console.log(`[bench:prober] pruned ${pruned} anchored probe results`);

        // Nothing due once every endpoint has been probed inside the staleness
        // window - that is the schedule working. Targets that were selected and
        // then all failed to produce a result is the case worth flagging.
        outcome.set(QUEUE.prober, r.probed > 0 ? 'worked' : r.failed > 0 ? 'idle' : 'nothing-due');
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
    /**
     * Auditions against a position a reader pasted, rather than the shared one.
     *
     * `/report` read the address from chain and then had nothing to run
     * against it, so it always answered "position only" and the product's
     * headline claim lived in the fixtures. This is the half that was missing:
     * mirror what the address actually holds onto a fork, drive the same
     * verified-live agents against it, and record the runs under a window
     * keyed by the address so the page can read them back.
     */
    new Worker(
      QUEUE.report,
      async () => {
        if (auditionService === null || archiveRpcUrl === null || reportStore === null) {
          outcome.set(QUEUE.report, 'nothing-due');
          return;
        }

        // A worker that died mid-run leaves a request claimed forever, and the
        // reader sits on "working on it" - the failure that looks like success.
        const freed = await reportStore.releaseStale(cfg.BENCH_CHAIN, 10 * 60_000);
        const req = await reportStore.claimNext(cfg.BENCH_CHAIN);
        if (req === null) {
          outcome.set(QUEUE.report, 'nothing-due');
          lastResult.set(
            QUEUE.report,
            `nothing queued${freed > 0 ? ` (freed ${freed} stale)` : ''}`,
          );
          return;
        }

        try {
          const live = await positions.read(req.address as `0x${string}`);
          const mirrored = mirrorPosition(
            {
              address: live.address,
              holdings: live.holdings.map((h) => ({
                token: h.token,
                symbol: h.symbol,
                amount: h.amount,
                valuedUsd: h.usdValue,
              })),
              nativeWei: live.holdings.find((h) => h.symbol === 'BNB')?.amount ?? 0n,
            },
            cfg.SHADOW_FORK_CHAIN,
          );

          if (mirrored === null) {
            // Naming the limit rather than reporting an empty result: "we hold
            // no slot for your token" and "no agent helped you" are different
            // answers and the page shows different things for them.
            await reportStore.finish(cfg.BENCH_CHAIN, req.address, {
              ok: false,
              reason:
                `this position is under $${MIN_AUDITIONABLE_USD}, or holds nothing Bench can ` +
                "mirror onto a fork. The seeded balance is also the agent's gas budget, so " +
                'below that an agent cannot afford to act and every result would say more about ' +
                'the position than the agent. Bench mirrors BNB plus one of USDT, USDC, BUSD, ' +
                'CAKE or WBNB.',
            });
            outcome.set(QUEUE.report, 'worked');
            lastResult.set(QUEUE.report, `${req.address.slice(0, 10)}… not mirrorable`);
            return;
          }

          const status = await checkArchiveRpc(
            archiveRpcUrl,
            cfg.SHADOW_FORK_CHAIN,
            FORK_LAG_BLOCKS,
          );
          const window = reportWindowFor(req.address, forkBlockFor(status.head));
          const r = await auditionService.tick(window, mirrored.template, { ignoreRecency: true });

          await reportStore.finish(cfg.BENCH_CHAIN, req.address, {
            ok: true,
            windowId: window.id,
            agentsRun: r.succeeded,
          });
          outcome.set(QUEUE.report, 'worked');
          lastResult.set(
            QUEUE.report,
            `${req.address.slice(0, 10)}… auditioned=${r.auditioned} ok=${r.succeeded} failed=${r.failed}`,
          );
          console.log(`[bench:report] ${req.address} ok=${r.succeeded} failed=${r.failed}`);
        } catch (err) {
          await reportStore.finish(cfg.BENCH_CHAIN, req.address, {
            ok: false,
            reason: redactError(err),
          });
          // Recorded against the request, so the reader sees why rather than
          // waiting; re-thrown so the queue counts it as a failure too.
          throw err;
        }
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
        const specs = auditionWindows({
          forkChain: cfg.SHADOW_FORK_CHAIN,
          forkBlock: forkBlockFor(status.head),
        });
        if (specs.length === 0) {
          console.log(
            `[bench:audition] no window for ${cfg.SHADOW_FORK_CHAIN} - no seeder constants`,
          );
          return;
        }
        /**
         * Rotate through the windows rather than always taking the first.
         *
         * There is more than one position now - a spot balance and a leveraged
         * Venus loan - and taking `[0]` would mean the lending position was
         * never auditioned, so health-factor agents would keep being scored on
         * a position with no health factor. Round-robin by tick, so each window
         * gets its turn and the cadence per window is the queue's cadence times
         * the number of windows.
         */
        const spec = specs[auditionTick % specs.length] as (typeof specs)[number];
        auditionTick += 1;
        const r = await auditionService.tick(spec.window, spec.position);
        const why = Object.entries(r.skipReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `${n}x ${reason}`)
          .join(', ');
        const summary =
          `window=${r.window} considered=${r.considered} auditioned=${r.auditioned} ` +
          `ok=${r.succeeded} failed=${r.failed} skipped=${r.skipped}` +
          // Without this, "skipped=20" says a tick did nothing and not whether
          // the catalog is exhausted, undrivable, or broken.
          (why === '' ? '' : ` (${why})`);
        // Every considered agent is either auditioned or skipped with a named
        // reason. An agent that is neither is unaccounted for, and that is
        // precisely the shape of the bug where MCP agents were dropped in
        // silence: considered, never audited, never explained.
        outcome.set(
          QUEUE.audition,
          r.auditioned > 0 ? 'worked' : r.considered > r.skipped ? 'idle' : 'nothing-due',
        );
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
        // Skipped here means "no outcomes recorded yet", which is the normal
        // state for most of the catalog. Candidates that were neither scored
        // nor skipped are not.
        // Skipped here means "no outcomes that still count as evidence", the
        // normal state for most of the catalog. Candidates that were neither
        // scored nor skipped are not accounted for by anything.
        outcome.set(
          QUEUE.scorer,
          r.scored > 0 || r.retracted > 0
            ? 'worked'
            : scorable.length > r.scored + r.skipped
              ? 'idle'
              : 'nothing-due',
        );
        lastResult.set(
          QUEUE.scorer,
          `scored=${r.scored} skipped=${r.skipped} thin=${r.thin}` +
            // Silent retraction would leave the catalog changing under a
            // reader with nothing here to explain why.
            (r.retracted > 0 ? ` retracted=${r.retracted}` : ''),
        );
        console.log(
          `[bench:scorer] scored=${r.scored} skipped=${r.skipped} (no evidence) ` +
            `thin=${r.thin} retracted=${r.retracted}`,
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
        outcome.set(QUEUE.crossref, summary.checked > 0 ? 'worked' : 'nothing-due');
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
      // Redacted at the boundary, not at the display: this string is stored,
      // served by /health and rendered on a public page, and viem puts the
      // whole archive-node URL - key included - in its message.
      heartbeat.fail(w.name, redactError(err));
      console.error(`[bench:worker] ${w.name} job ${job?.id ?? '?'} failed:`, err);
    });
    w.on('completed', () => {
      heartbeat.mark(w.name, lastResult.get(w.name), outcome.get(w.name));
    });
  }

  // Repeatable jobs are idempotent by repeat key, so re-adding them on every
  // boot is the intended way to keep the schedule in sync with the code.
  const [indexQ, probeQ, anchorQ, auditionQ, scorerQ, crossrefQ, reportQ] = queues as [
    Queue,
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
  // Only when auditions can run at all: a report queue without an archive node
  // would claim requests and fail every one of them, which is worse for the
  // reader than the page saying up front that it cannot run one.
  if (auditionService !== null) {
    await auditionQ.add('tick', {}, repeatOpts(CADENCE_MS.audition));
    await reportQ.add('tick', {}, repeatOpts(CADENCE_MS.report));
  }

  const registered = [
    `indexer/${CADENCE_MS.indexer}ms`,
    `prober/${CADENCE_MS.prober}ms`,
    `scorer/${CADENCE_MS.scorer}ms`,
    `crossref/${CADENCE_MS.crossref}ms`,
    ...(auditionService === null
      ? []
      : [`audition/${CADENCE_MS.audition}ms`, `report/${CADENCE_MS.report}ms`]),
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
