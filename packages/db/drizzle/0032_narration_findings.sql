CREATE TABLE "narration_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"language" text NOT NULL,
	"source" text NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"line_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_chapter_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "narration_findings" ADD CONSTRAINT "narration_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "narration_findings" ADD CONSTRAINT "narration_findings_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "narration_findings_fingerprint_uq" ON "narration_findings" USING btree ("chapter_id","language","source","fingerprint");--> statement-breakpoint
CREATE INDEX "narration_findings_project_idx" ON "narration_findings" USING btree ("project_id","language");