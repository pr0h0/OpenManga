ALTER TYPE "public"."asset_type" ADD VALUE 'panel_clip';--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "video_seconds" numeric(10, 3) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "provider_rate_snapshots" ADD COLUMN "video_second_rate" numeric(12, 6) DEFAULT '0' NOT NULL;