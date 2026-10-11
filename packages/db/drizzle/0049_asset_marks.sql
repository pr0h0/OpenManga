CREATE TABLE "asset_marks" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"favourite" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_marks" ADD CONSTRAINT "asset_marks_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_marks" ADD CONSTRAINT "asset_marks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_marks_project_idx" ON "asset_marks" USING btree ("project_id");