CREATE TABLE "prompt_overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"template_name" text NOT NULL,
	"version" integer NOT NULL,
	"rules" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "prompt_overrides" ADD CONSTRAINT "prompt_overrides_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "prompt_overrides_uq" ON "prompt_overrides" USING btree ("project_id","template_name","version");