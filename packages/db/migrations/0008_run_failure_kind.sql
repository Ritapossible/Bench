-- Why an audition produced nothing, in four kinds rather than one sentence.
--
-- `failure_reason` has always held the agent's own words, which is the right
-- thing to show a reader and the wrong thing to count. "Agents auditioned: 18"
-- counted eighteen runs of which one completed, several were declined by the
-- agent in its own words, and one named a service at localhost - three
-- different facts about the ecosystem, indistinguishable in one number.
--
-- Nullable and not backfilled on purpose. Every row already in this table
-- predates the loopback-RPC, agent-card, A2A-refusal, MCP-refusal and prober
-- fixes, so its stored reason describes a Bench bug rather than an agent.
-- Guessing a kind from those sentences would restate old mistakes as findings
-- about strangers' agents. They read as unclassified until they are re-run.
alter table shadow_runs add column if not exists failure_kind text;

create index if not exists shadow_runs_failure_kind_idx
  on shadow_runs (failure_kind)
  where failure_kind is not null;
