CREATE TABLE "asset_features" (
	"asset_id" uuid PRIMARY KEY NOT NULL,
	"dhash" text NOT NULL,
	"center" jsonb NOT NULL,
	"border" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_features" ADD CONSTRAINT "asset_features_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE cascade ON UPDATE no action;