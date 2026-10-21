CREATE TABLE "activity_stats" (
	"user_id" uuid NOT NULL,
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"ms" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "activity_stats_user_id_day_kind_source_key_pk" PRIMARY KEY("user_id","day","kind","source","key")
);
--> statement-breakpoint
ALTER TABLE "activity_stats" ADD CONSTRAINT "activity_stats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_stats_day_idx" ON "activity_stats" USING btree ("day");