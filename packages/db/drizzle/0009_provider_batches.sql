ALTER TYPE "public"."job_status" ADD VALUE 'submitted' BEFORE 'processing';--> statement-breakpoint
CREATE TABLE "provider_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid,
	"batch_id" uuid,
	"capability" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"handle" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"request_count" integer DEFAULT 0 NOT NULL,
	"completed_count" integer DEFAULT 0 NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"owned_file_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"failure_reason" text,
	"submitted_at" timestamp with time zone,
	"polled_at" timestamp with time zone,
	"ingested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_batches" ADD CONSTRAINT "provider_batches_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_batches" ADD CONSTRAINT "provider_batches_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_batches_idempotency_idx" ON "provider_batches" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "provider_batches_state_idx" ON "provider_batches" USING btree ("state","polled_at");--> statement-breakpoint
CREATE INDEX "provider_batches_project_idx" ON "provider_batches" USING btree ("project_id","created_at");