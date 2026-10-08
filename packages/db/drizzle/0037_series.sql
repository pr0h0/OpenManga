CREATE TABLE "series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"library_project_id" uuid NOT NULL,
	"channel_profile_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bible_facts" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "synced_version_id" uuid;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "locations" ADD COLUMN "synced_version_id" uuid;--> statement-breakpoint
ALTER TABLE "project_styles" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "series_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "series_role" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "episode_number" integer;--> statement-breakpoint
ALTER TABLE "props" ADD COLUMN "source_id" uuid;--> statement-breakpoint
ALTER TABLE "props" ADD COLUMN "synced_version_id" uuid;--> statement-breakpoint
ALTER TABLE "series" ADD CONSTRAINT "series_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "series_owner_idx" ON "series" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "projects_series_idx" ON "projects" USING btree ("series_id");