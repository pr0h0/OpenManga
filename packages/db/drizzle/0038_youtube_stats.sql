CREATE TABLE "youtube_channels" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"channel_id" text NOT NULL,
	"title" text NOT NULL,
	"thumbnail_url" text,
	"uploads_playlist_id" text,
	"encrypted_refresh_token" text NOT NULL,
	"encrypted_access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reporting" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reporting_error" text,
	"status" text DEFAULT 'active' NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"channel_id" text,
	"channel_title" text,
	"connection_id" uuid,
	"kind" text DEFAULT 'film' NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"thumbnail_url" text,
	"published_at" timestamp with time zone,
	"duration_seconds" integer,
	"export_id" uuid,
	"short_id" text,
	"label" text DEFAULT '' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "youtube_reach" (
	"connection_id" uuid NOT NULL,
	"video_id" text NOT NULL,
	"day" date NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"impressions" bigint NOT NULL,
	"ctr" real,
	CONSTRAINT "youtube_reach_connection_id_video_id_day_source_pk" PRIMARY KEY("connection_id","video_id","day","source")
);
--> statement-breakpoint
CREATE TABLE "youtube_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"video_id" text NOT NULL,
	"taken_at" timestamp with time zone DEFAULT now() NOT NULL,
	"views" bigint NOT NULL,
	"likes" bigint,
	"comments" bigint,
	"connection_id" uuid,
	"authorized" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "youtube_channels" ADD CONSTRAINT "youtube_channels_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_links" ADD CONSTRAINT "youtube_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_links" ADD CONSTRAINT "youtube_links_connection_id_youtube_channels_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."youtube_channels"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_links" ADD CONSTRAINT "youtube_links_export_id_exports_id_fk" FOREIGN KEY ("export_id") REFERENCES "public"."exports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_links" ADD CONSTRAINT "youtube_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_reach" ADD CONSTRAINT "youtube_reach_connection_id_youtube_channels_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."youtube_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "youtube_snapshots" ADD CONSTRAINT "youtube_snapshots_connection_id_youtube_channels_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."youtube_channels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_channels_user_channel_uq" ON "youtube_channels" USING btree ("user_id","channel_id");--> statement-breakpoint
CREATE UNIQUE INDEX "youtube_links_project_video_uq" ON "youtube_links" USING btree ("project_id","video_id");--> statement-breakpoint
CREATE INDEX "youtube_links_video_idx" ON "youtube_links" USING btree ("video_id");--> statement-breakpoint
CREATE INDEX "youtube_reach_video_idx" ON "youtube_reach" USING btree ("video_id","day");--> statement-breakpoint
CREATE INDEX "youtube_snapshots_video_idx" ON "youtube_snapshots" USING btree ("video_id","taken_at");--> statement-breakpoint
CREATE INDEX "youtube_snapshots_taken_idx" ON "youtube_snapshots" USING btree ("taken_at");