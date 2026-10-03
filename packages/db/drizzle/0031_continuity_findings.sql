CREATE TABLE "continuity_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"job_id" uuid,
	"severity" text NOT NULL,
	"message" text NOT NULL,
	"quote" text DEFAULT '' NOT NULL,
	"evidence" text DEFAULT '' NOT NULL,
	"place" jsonb NOT NULL,
	"fact_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text DEFAULT '' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "continuity_findings" ADD CONSTRAINT "continuity_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_findings" ADD CONSTRAINT "continuity_findings_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_findings" ADD CONSTRAINT "continuity_findings_fact_id_bible_facts_id_fk" FOREIGN KEY ("fact_id") REFERENCES "public"."bible_facts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "continuity_findings" ADD CONSTRAINT "continuity_findings_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "continuity_findings_project_idx" ON "continuity_findings" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "continuity_findings_chapter_idx" ON "continuity_findings" USING btree ("chapter_id");