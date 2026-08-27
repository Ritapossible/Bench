CREATE TABLE "agent_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"url" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_liveness" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"last_probed_at" timestamp with time zone,
	"reachable" boolean DEFAULT false NOT NULL,
	"conformant" boolean DEFAULT false NOT NULL,
	"uptime_bps" integer DEFAULT 0 NOT NULL,
	"p95_latency_ms" integer,
	"probe_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"token_id" numeric(78, 0) NOT NULL,
	"owner" text NOT NULL,
	"card_uri" text NOT NULL,
	"category" text DEFAULT 'other' NOT NULL,
	"card" jsonb,
	"card_error" text,
	"registered_at" timestamp with time zone NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audition_windows" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"regime" text NOT NULL,
	"fork_block" bigint NOT NULL,
	"end_block" bigint NOT NULL,
	"seed" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escrow_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" uuid NOT NULL,
	"client" text NOT NULL,
	"amount_token" text NOT NULL,
	"amount" numeric(78, 0) NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"dispute_window_ends_at" timestamp with time zone,
	"delivery_proof" text
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hire_id" text NOT NULL,
	"escrow_job_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text,
	"weight" double precision NOT NULL,
	"settled_value_usd" double precision NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hires" (
	"id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"user_address" text NOT NULL,
	"agent_ids" jsonb NOT NULL,
	"escrow_job_id" text,
	"session_key_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"mandate" jsonb NOT NULL,
	"mandate_state" jsonb NOT NULL,
	"envelope" jsonb NOT NULL,
	"envelope_policy" jsonb,
	"trace" jsonb NOT NULL,
	"payment_tx_hash" text,
	"failure_reason" text,
	"broker_intent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "indexer_checkpoints" (
	"chain" text PRIMARY KEY NOT NULL,
	"last_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outcome_records" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"terminal_value_usd" double precision NOT NULL,
	"terminal_detail" jsonb NOT NULL,
	"delta_vs_do_nothing_usd" double precision NOT NULL,
	"delta_vs_peer_median_usd" double precision,
	"max_drawdown_usd" double precision NOT NULL,
	"action_count" integer NOT NULL,
	"replay_hash" text NOT NULL,
	"attested_tx_hash" text
);
--> statement-breakpoint
CREATE TABLE "probe_anchors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"digest" text NOT NULL,
	"previous_digest" text NOT NULL,
	"tx_hash" text NOT NULL,
	"covers_up_to" timestamp with time zone NOT NULL,
	"probe_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"reachable" boolean NOT NULL,
	"latency_ms" integer,
	"conformant" boolean NOT NULL,
	"error" text,
	"anchored_digest" text
);
--> statement-breakpoint
CREATE TABLE "scores" (
	"agent_id" uuid NOT NULL,
	"category" text NOT NULL,
	"basis" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"sample_size" integer NOT NULL,
	"baseline" jsonb NOT NULL,
	"normalized" double precision NOT NULL,
	"metric" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scores_agent_id_category_basis_window_end_pk" PRIMARY KEY("agent_id","category","basis","window_end")
);
--> statement-breakpoint
CREATE TABLE "session_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"owner" text NOT NULL,
	"spend_cap_token" text NOT NULL,
	"spend_cap" numeric(78, 0) NOT NULL,
	"spent" numeric(78, 0) DEFAULT '0' NOT NULL,
	"contract_allowlist" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "shadow_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"to" text,
	"value" numeric(78, 0) NOT NULL,
	"data" text NOT NULL,
	"decoded" jsonb,
	"sim_success" boolean NOT NULL,
	"sim_gas_used" numeric(78, 0) NOT NULL,
	"revert_reason" text
);
--> statement-breakpoint
CREATE TABLE "shadow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"window_id" text NOT NULL,
	"position_kind" text NOT NULL,
	"position_params" jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"egress_spent_usd" double precision DEFAULT 0 NOT NULL,
	"failure_reason" text
);
--> statement-breakpoint
ALTER TABLE "agent_endpoints" ADD CONSTRAINT "agent_endpoints_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_liveness" ADD CONSTRAINT "agent_liveness_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escrow_jobs" ADD CONSTRAINT "escrow_jobs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_hire_id_hires_id_fk" FOREIGN KEY ("hire_id") REFERENCES "public"."hires"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_escrow_job_id_escrow_jobs_id_fk" FOREIGN KEY ("escrow_job_id") REFERENCES "public"."escrow_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hires" ADD CONSTRAINT "hires_session_key_id_session_keys_id_fk" FOREIGN KEY ("session_key_id") REFERENCES "public"."session_keys"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outcome_records" ADD CONSTRAINT "outcome_records_run_id_shadow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_results" ADD CONSTRAINT "probe_results_endpoint_id_agent_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."agent_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scores" ADD CONSTRAINT "scores_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_actions" ADD CONSTRAINT "shadow_actions_run_id_shadow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."shadow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shadow_runs" ADD CONSTRAINT "shadow_runs_window_id_audition_windows_id_fk" FOREIGN KEY ("window_id") REFERENCES "public"."audition_windows"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_endpoints_agent_url_idx" ON "agent_endpoints" USING btree ("agent_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_chain_token_idx" ON "agents" USING btree ("chain","token_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hires_idempotency_key_uq" ON "hires" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "hires_user_idx" ON "hires" USING btree ("user_address");--> statement-breakpoint
CREATE INDEX "probe_anchors_created_idx" ON "probe_anchors" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "probe_agent_at_idx" ON "probe_results" USING btree ("agent_id","at");--> statement-breakpoint
CREATE INDEX "probe_unanchored_idx" ON "probe_results" USING btree ("anchored_digest","at");--> statement-breakpoint
CREATE INDEX "runs_agent_window_idx" ON "shadow_runs" USING btree ("agent_id","window_id");