-- Gas the agent burned during an audition, priced in the window's unit of
-- account. The TermiX report compares agent against no-agent on time, cost and
-- output quality, and "cost" was the egress meter alone - which is zero for
-- every remote agent, because the shim calls the endpoint directly rather than
-- through the meter. So "did the agent beat doing nothing, net of cost" was
-- being decided against a cost of exactly zero.
--
-- Defaulted to 0: existing runs genuinely did not measure this, and the runs
-- that matter recorded no transactions at all, so their gas really was zero.
ALTER TABLE "shadow_runs" ADD COLUMN "gas_spent_usd" double precision DEFAULT 0 NOT NULL;
