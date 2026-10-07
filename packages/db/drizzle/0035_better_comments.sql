ALTER TABLE "panel_comments" ADD COLUMN "guest_name" text;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "share_id" uuid;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "anchor" jsonb;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "timecode_ms" integer;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "assignee_user_id" uuid;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "artwork_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "resolved_artwork_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "share_links" ADD COLUMN "allow_comments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD CONSTRAINT "panel_comments_share_id_share_links_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."share_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD CONSTRAINT "panel_comments_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;