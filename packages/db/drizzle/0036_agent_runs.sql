CREATE TABLE "agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"status" text DEFAULT 'planning' NOT NULL,
	"budget_usd" numeric(10, 2),
	"spend_at_start_usd" numeric(14, 8) DEFAULT '0' NOT NULL,
	"run" jsonb NOT NULL,
	"plan" jsonb,
	"feedback" text,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"current_job_id" uuid,
	"approval_request_id" uuid,
	"summary" text,
	"error" text,
	"locked_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_project_idx" ON "agent_runs" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_idx" ON "agent_runs" USING btree ("status");