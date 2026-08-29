CREATE TABLE "crossref_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chain" text NOT NULL,
	"source" text NOT NULL,
	"status" text NOT NULL,
	"checked" integer NOT NULL,
	"confirmed" integer NOT NULL,
	"not_found" integer NOT NULL,
	"agreement_bps" integer NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "crossref_chain_time_idx" ON "crossref_summaries" USING btree ("chain","computed_at");