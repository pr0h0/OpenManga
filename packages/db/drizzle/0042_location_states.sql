CREATE TABLE "location_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"location_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_chapter_id" uuid,
	"until_chapter_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "reference_assets" ADD COLUMN "location_state_id" uuid;--> statement-breakpoint
ALTER TABLE "scenes" ADD COLUMN "location_state_id" uuid;--> statement-breakpoint
ALTER TABLE "location_states" ADD CONSTRAINT "location_states_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_states" ADD CONSTRAINT "location_states_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_states" ADD CONSTRAINT "location_states_from_chapter_id_chapters_id_fk" FOREIGN KEY ("from_chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "location_states" ADD CONSTRAINT "location_states_until_chapter_id_chapters_id_fk" FOREIGN KEY ("until_chapter_id") REFERENCES "public"."chapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "location_states_location_idx" ON "location_states" USING btree ("location_id");--> statement-breakpoint
ALTER TABLE "reference_assets" ADD CONSTRAINT "reference_assets_location_state_id_location_states_id_fk" FOREIGN KEY ("location_state_id") REFERENCES "public"."location_states"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scenes" ADD CONSTRAINT "scenes_location_state_id_location_states_id_fk" FOREIGN KEY ("location_state_id") REFERENCES "public"."location_states"("id") ON DELETE set null ON UPDATE no action;