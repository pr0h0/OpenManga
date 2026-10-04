ALTER TABLE "production_runs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "production_runs" ADD COLUMN "lease_until" timestamp with time zone;