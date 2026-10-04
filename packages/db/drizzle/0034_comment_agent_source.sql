ALTER TABLE "panel_comments" ADD COLUMN "via_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "via_service_id" uuid;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "resolved_via_agent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD COLUMN "resolved_via_service_id" uuid;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD CONSTRAINT "panel_comments_via_service_id_user_services_id_fk" FOREIGN KEY ("via_service_id") REFERENCES "public"."user_services"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "panel_comments" ADD CONSTRAINT "panel_comments_resolved_via_service_id_user_services_id_fk" FOREIGN KEY ("resolved_via_service_id") REFERENCES "public"."user_services"("id") ON DELETE set null ON UPDATE no action;