-- The catalog page displayed `(normalized - 0.5) * 800` as a dollar amount
-- captioned "vs doing nothing". `normalized` is a bounded tanh of
-- delta-over-capital, so that expression is not the delta - it is a number in
-- dollars matching nothing the system ever measured. Record the real figures.
--
-- Defaulted to 0 rather than backfilled: the existing rows genuinely do not
-- carry these dollars, and deriving them from `normalized` would repeat the
-- original mistake inside the database. The scorer overwrites every row with
-- measured values on its next pass.
ALTER TABLE "scores" ADD COLUMN "mean_delta_usd" double precision DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "scores" ADD COLUMN "capital_usd" double precision DEFAULT 0 NOT NULL;
