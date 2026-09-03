-- Two joins that had no index to run on.
--
-- `dueForProbe` groups probe_results by endpoint on every prober tick, and
-- Postgres does not index foreign keys for you - so that was a full pass over
-- the entire probe history once a minute, degrading for as long as the
-- deployment stayed up. `outcomesFor` and `failedAuditions` both filter
-- shadow_runs on status and order by finish time, with nothing to support
-- either.
CREATE INDEX "probe_endpoint_at_idx" ON "probe_results" USING btree ("endpoint_id","at");--> statement-breakpoint
CREATE INDEX "runs_status_finished_idx" ON "shadow_runs" USING btree ("status","finished_at");