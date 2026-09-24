CREATE TABLE "outfit_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"character_id" uuid NOT NULL,
	"outfit_id" uuid NOT NULL,
	"panel_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outfit_assignments" ADD CONSTRAINT "outfit_assignments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outfit_assignments" ADD CONSTRAINT "outfit_assignments_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outfit_assignments" ADD CONSTRAINT "outfit_assignments_outfit_id_character_outfits_id_fk" FOREIGN KEY ("outfit_id") REFERENCES "public"."character_outfits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outfit_assignments" ADD CONSTRAINT "outfit_assignments_panel_id_panels_id_fk" FOREIGN KEY ("panel_id") REFERENCES "public"."panels"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outfit_assignments_uq" ON "outfit_assignments" USING btree ("character_id","panel_id","scope");--> statement-breakpoint
CREATE INDEX "outfit_assignments_project_idx" ON "outfit_assignments" USING btree ("project_id");