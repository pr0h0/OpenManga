ALTER TABLE "chapters" ADD COLUMN "publish_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "visibility" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "series" ADD COLUMN "public_slug" text;--> statement-breakpoint
CREATE UNIQUE INDEX "series_public_slug_uq" ON "series" USING btree ("public_slug");