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
    registeredAt: timestamp('registered_at', { withTimezone: true }).notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('agents_chain_token_idx').on(t.chain, t.tokenId)],
);

export const agentEndpoints = pgTable('agent_endpoints', {
  id: uuid('id').defaultRandom().primaryKey(),
  agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
  protocol: text('protocol').notNull(),
  url: text('url').notNull(),
});

export const probeResults = pgTable(
  'probe_results',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id').notNull().references(() => agentEndpoints.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    reachable: boolean('reachable').notNull(),
    latencyMs: integer('latency_ms'),
    conformant: boolean('conformant').notNull(),
    error: text('error'),
    anchoredDigest: text('anchored_digest'),
  },
  (t) => [index('probe_agent_at_idx').on(t.agentId, t.at)],
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
    id: uuid('id').defaultRandom().primaryKey(),
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    windowId: text('window_id').notNull().references(() => auditionWindows.id),
    positionKind: text('position_kind').notNull(),
    positionParams: jsonb('position_params').notNull(),
    status: text('status').notNull().default('queued'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    egressSpentUsd: doublePrecision('egress_spent_usd').notNull().default(0),
    failureReason: text('failure_reason'),
  },
  (t) => [index('runs_agent_window_idx').on(t.agentId, t.windowId)],
);

export const shadowActions = pgTable('shadow_actions', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').notNull().references(() => shadowRuns.id, { onDelete: 'cascade' }),
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
  runId: uuid('run_id').primaryKey().references(() => shadowRuns.id, { onDelete: 'cascade' }),
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
    agentId: uuid('agent_id').notNull().references(() => agents.id, { onDelete: 'cascade' }),
    category: text('category').notNull(),
    // 'simulated' | 'realized' — never merged. Two columns, always labelled.
    basis: text('basis').notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    windowEnd: timestamp('window_end', { withTimezone: true }).notNull(),
    sampleSize: integer('sample_size').notNull(),
    baseline: jsonb('baseline').notNull(),
    normalized: doublePrecision('normalized').notNull(),
    metric: jsonb('metric').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.agentId, t.category, t.basis, t.windowEnd] })],
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
  agentId: uuid('agent_id').notNull().references(() => agents.id),
  client: text('client').notNull(),
  amountToken: text('amount_token').notNull(),
  amount: numeric('amount', { precision: 78, scale: 0 }).notNull(),
  status: text('status').notNull().default('open'),
  disputeWindowEndsAt: timestamp('dispute_window_ends_at', { withTimezone: true }),
  deliveryProof: text('delivery_proof'),
});

export const hires = pgTable('hires', {
  id: uuid('id').defaultRandom().primaryKey(),
  userAddress: text('user_address').notNull(),
  agentIds: jsonb('agent_ids').notNull(),
  escrowJobId: text('escrow_job_id').references(() => escrowJobs.id),
  sessionKeyId: uuid('session_key_id').references(() => sessionKeys.id),
  status: text('status').notNull().default('pending'),
  brokerIntent: text('broker_intent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Payment-gated. A row may only exist with a settled escrow job behind it —
 * enforced in the write path, and the reason Sybil review farming costs real
 * money here.
 */
export const feedback = pgTable('feedback', {
  id: uuid('id').defaultRandom().primaryKey(),
  hireId: uuid('hire_id').notNull().references(() => hires.id, { onDelete: 'cascade' }),
  escrowJobId: text('escrow_job_id').notNull().references(() => escrowJobs.id),
  rating: integer('rating').notNull(),
  comment: text('comment'),
  weight: doublePrecision('weight').notNull(),
  settledValueUsd: doublePrecision('settled_value_usd').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
