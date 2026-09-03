-- On-demand auditions against a reader's own position.
--
-- /report read the address from chain and then had nothing to run against it,
-- so it always answered "position only": the product's headline claim - "this
-- agent would have saved you $340 on your position" - existed in the fixtures
-- and nowhere else. This is the queue that makes it a measurement.
CREATE TABLE "report_requests" (
	"chain" text NOT NULL,
	"address" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"window_id" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"agents_run" integer DEFAULT 0 NOT NULL,
	"failure_reason" text,
	CONSTRAINT "report_requests_chain_address_pk" PRIMARY KEY("chain","address")
);
