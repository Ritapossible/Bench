import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// Mirrors ARCHITECTURE.md section 4. Token amounts are stored as numeric(78,0)
// — big enough for uint256 base units — never as float.

export const agents = pgTable(
  'agents',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chain: text('chain').notNull(),
    tokenId: numeric('token_id', { precision: 78, scale: 0 }).notNull(),
    owner: text('owner').notNull(),
    cardUri: text('card_uri').notNull(),
    category: text('category').notNull().default('other'),
    // Null is the common case: most tokenURIs do not resolve.
    card: jsonb('card'),
    // Why it did not resolve. Kept because the failure reasons are the
    // evidence behind the catalog-density figure Bench publishes.
    cardError: text('card_error'),
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Unique, not merely indexed: it is the upsert conflict target, which is
  // what makes re-indexing a block range idempotent rather than duplicating.
  (t) => [uniqueIndex('agents_chain_token_idx').on(t.chain, t.tokenId)],
);

export const agentEndpoints = pgTable(
  'agent_endpoints',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    protocol: text('protocol').notNull(),
    url: text('url').notNull(),
  },
  (t) => [uniqueIndex('agent_endpoints_agent_url_idx').on(t.agentId, t.url)],
);

export const probeResults = pgTable(
  'probe_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id')
      .notNull()
      .references(() => agentEndpoints.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    reachable: boolean('reachable').notNull(),
    latencyMs: integer('latency_ms'),
    conformant: boolean('conformant').notNull(),
    error: text('error'),
    anchoredDigest: text('anchored_digest'),
  },
  (t) => [
    index('probe_agent_at_idx').on(t.agentId, t.at),
    // The anchor job scans for probes with no digest yet, oldest first.
    index('probe_unanchored_idx').on(t.anchoredDigest, t.at),
  ],
);

/**
 * Rolling liveness per agent, recomputed on every probe write.
 *
 * Denormalised deliberately. The "verified live" filter has to be a WHERE
 * clause: folding probe history in application code would mean loading the
 * whole catalog to render one filtered page, and this filter is the single
 * most-used query in the product. Correctness comes from having exactly one
 * writer — CatalogRepository.recordProbe — and from `isVerifiedLive` in
 * @bench/core remaining the only definition of the predicate.
 */
export const agentLiveness = pgTable('agent_liveness', {
  agentId: uuid('agent_id')
    .primaryKey()
    .references(() => agents.id, { onDelete: 'cascade' }),
  lastProbedAt: timestamp('last_probed_at', { withTimezone: true }),
  reachable: boolean('reachable').notNull().default(false),
  conformant: boolean('conformant').notNull().default(false),
  uptimeBps: integer('uptime_bps').notNull().default(0),
  p95LatencyMs: integer('p95_latency_ms'),
  probeCount: integer('probe_count').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Where the indexer resumes. One row per chain, so a bad decode is recovered
 * by rewinding a single value rather than replaying the registry from genesis.
 */
export const indexerCheckpoints = pgTable('indexer_checkpoints', {
  chain: text('chain').primaryKey(),
  lastBlock: bigint('last_block', { mode: 'bigint' }).notNull(),
  // Enumeration resume point. Nullable: a deployment that only scans logs never
  // sets it, and a deployment that only enumerates never advances lastBlock.
  lastTokenId: bigint('last_token_id', { mode: 'bigint' }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Onchain commitments to the probe record. Each digest folds in the previous
 * one, so the rows form a hash chain: rewriting any historical probe batch
 * invalidates every anchor after it, and those are onchain. This is what makes
 * liveness auditable rather than a claim Bench makes about its own database.
 */
export const probeAnchors = pgTable(
  'probe_anchors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    digest: text('digest').notNull(),
    previousDigest: text('previous_digest').notNull(),
    txHash: text('tx_hash').notNull(),
    coversUpTo: timestamp('covers_up_to', { withTimezone: true }).notNull(),
    probeCount: integer('probe_count').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('probe_anchors_created_idx').on(t.createdAt)],
);

export const auditionWindows = pgTable('audition_windows', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  regime: text('regime').notNull(),
  forkBlock: bigint('fork_block', { mode: 'bigint' }).notNull(),
  endBlock: bigint('end_block', { mode: 'bigint' }).notNull(),
  seed: text('seed').notNull(),
});

export const shadowRuns = pgTable(
  'shadow_runs',
  {
    id: text('id').primaryKey(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    windowId: text('window_id')
      .notNull()
      .references(() => auditionWindows.id),
    positionKind: text('position_kind').notNull(),
    positionParams: jsonb('position_params').notNull(),
    status: text('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    egressSpentUsd: doublePrecision('egress_spent_usd').notNull().default(0),
    // Gas the agent burned, priced in the window's unit of account. The cost
    // its advantage has to beat, and previously not counted at all.
    gasSpentUsd: doublePrecision('gas_spent_usd').notNull().default(0),
    failureReason: text('failure_reason'),
  },
  (t) => [index('runs_agent_window_idx').on(t.agentId, t.windowId)],
);

export const shadowActions = pgTable('shadow_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: text('run_id')
    .notNull()
    .references(() => shadowRuns.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(),
  at: timestamp('at', { withTimezone: true }).notNull(),
  to: text('to'),
  value: numeric('value', { precision: 78, scale: 0 }).notNull(),
  data: text('data').notNull(),
  decoded: jsonb('decoded'),
  simSuccess: boolean('sim_success').notNull(),
  simGasUsed: numeric('sim_gas_used', { precision: 78, scale: 0 }).notNull(),
  revertReason: text('revert_reason'),
});

export const outcomeRecords = pgTable('outcome_records', {
  runId: text('run_id')
    .primaryKey()
    .references(() => shadowRuns.id, { onDelete: 'cascade' }),
  terminalValueUsd: doublePrecision('terminal_value_usd').notNull(),
  terminalDetail: jsonb('terminal_detail').notNull(),
  deltaVsDoNothingUsd: doublePrecision('delta_vs_do_nothing_usd').notNull(),
  deltaVsPeerMedianUsd: doublePrecision('delta_vs_peer_median_usd'),
  maxDrawdownUsd: doublePrecision('max_drawdown_usd').notNull(),
  actionCount: integer('action_count').notNull(),
  replayHash: text('replay_hash').notNull(),
  attestedTxHash: text('attested_tx_hash'),
});

export const scores = pgTable(
  'scores',
  {
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    // 'simulated' | 'realized' — never merged. Two columns, always labelled.
    basis: text('basis').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    sampleSize: integer('sample_size').notNull(),
    baseline: jsonb('baseline').notNull(),
    normalized: doublePrecision('normalized').notNull(),
    // The dollars behind `normalized`. Stored because tanh is not invertible:
    // without these two columns nothing downstream can name a real amount.
    meanDeltaUsd: doublePrecision('mean_delta_usd').notNull().default(0),
    capitalUsd: doublePrecision('capital_usd').notNull().default(0),
    metric: jsonb('metric').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.category, t.basis, t.windowEnd] })],
);

/**
 * Catalog density over time.
 *
 * Appended by the indexer rather than computed on demand, because the registry
 * health dashboard plots a trend, and a trend drawn through a number recomputed
 * at render time is not a history - it is today's number repeated across the
 * x-axis. One row per measurement, never updated.
 */
export const catalogStatsHistory = pgTable(
  'catalog_stats_history',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chain: text('chain').notNull(),
    registered: integer('registered').notNull(),
    withResolvableCard: integer('with_resolvable_card').notNull(),
    verifiedLive: integer('verified_live').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('catalog_stats_chain_time_idx').on(t.chain, t.computedAt)],
);

/**
 * Latest corroboration result, computed by the worker rather than per request.
 *
 * Cross-referencing a catalog page means one API call per agent. Doing that
 * inside a page render made /registry take about forty seconds once an API key
 * was configured - the pacer serialises requests, so concurrency does not help
 * and simultaneous visitors queue behind each other - while burning the day's
 * quota a pageview at a time. One row, written on a schedule, read instantly.
 */
export const crossRefSummaries = pgTable(
  'crossref_summaries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    chain: text('chain').notNull(),
    source: text('source').notNull(),
    status: text('status').notNull(),
    checked: integer('checked').notNull(),
    confirmed: integer('confirmed').notNull(),
    notFound: integer('not_found').notNull(),
    agreementBps: integer('agreement_bps').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('crossref_chain_time_idx').on(t.chain, t.computedAt)],
);

export const sessionKeys = pgTable('session_keys', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull(),
  owner: text('owner').notNull(),
  spendCapToken: text('spend_cap_token').notNull(),
  spendCap: numeric('spend_cap', { precision: 78, scale: 0 }).notNull(),
  spent: numeric('spent', { precision: 78, scale: 0 }).notNull().default('0'),
  contractAllowlist: jsonb('contract_allowlist').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

export const escrowJobs = pgTable('escrow_jobs', {
  id: text('id').primaryKey(),
  agentId: uuid('agent_id')
    .notNull()
    .references(() => agents.id),
  client: text('client').notNull(),
  amountToken: text('amount_token').notNull(),
  amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
  status: text('status').notNull().default('open'),
  disputeWindowEndsAt: timestamp('dispute_window_ends_at', { withTimezone: true }),
  deliveryProof: text('delivery_proof'),
});

/**
 * A hire, and everything needed to reconstruct one.
 *
 * `id` is text rather than a generated uuid because the domain mints it - the
 * orchestrator has to name a hire before any of this exists, so that a crash
 * between charging and persisting still leaves something to reconcile.
 *
 * `idempotencyKey` is UNIQUE, and that is the point. Deduplicating in
 * application memory is a race: two concurrent requests both miss the cache and
 * both charge. The uniqueness has to be enforced where the concurrency actually
 * resolves, which is here.
 */
export const hires = pgTable(
  'hires',
  {
    id: text('id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull(),
    userAddress: text('user_address').notNull(),
    /** One element for a direct hire; several when the broker assembles a team. */
    agentIds: jsonb('agent_ids').notNull(),
    escrowJobId: text('escrow_job_id'),
    sessionKeyId: uuid('session_key_id').references(() => sessionKeys.id),
    status: text('status').notNull().default('draft'),
    mandate: jsonb('mandate').notNull(),
    /** Owner signature over the mandate digest. Null until a wallet signs one. */
    mandateSignature: jsonb('mandate_signature'),
    mandateState: jsonb('mandate_state').notNull(),
    envelope: jsonb('envelope').notNull(),
    envelopePolicy: jsonb('envelope_policy'),
    /** Hash-chained; verified on read rather than trusted. */
    trace: jsonb('trace').notNull(),
    paymentTxHash: text('payment_tx_hash'),
    failureReason: text('failure_reason'),
    brokerIntent: text('broker_intent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('hires_idempotency_key_uq').on(t.idempotencyKey),
    index('hires_user_idx').on(t.userAddress),
  ],
);

/**
 * Payment-gated. A row may only exist with a settled escrow job behind it —
 * enforced in the write path, and the reason Sybil review farming costs real
 * money here.
 */
export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  hireId: text('hire_id')
    .notNull()
    .references(() => hires.id, { onDelete: 'cascade' }),
  escrowJobId: text('escrow_job_id')
    .notNull()
    .references(() => escrowJobs.id),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  weight: doublePrecision('weight').notNull(),
  settledValueUsd: doublePrecision('settled_value_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
