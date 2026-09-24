CREATE TABLE "mcp_approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" uuid,
	"tool_name" text NOT NULL,
	"action_key" text NOT NULL,
	"sensitivity" text NOT NULL,
	"summary" text NOT NULL,
	"arguments" jsonb NOT NULL,
	"arguments_hash" text NOT NULL,
	"idempotency_key" text,
	"target_snapshot" jsonb,
	"estimate" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_reason" text,
	"result" jsonb,
	"error" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"executed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_approval_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"action_key" text NOT NULL,
	"decision" text NOT NULL,
	"source_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_idempotency" (
	"service_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"key" text NOT NULL,
	"arguments_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_idempotency_service_id_tool_name_key_pk" PRIMARY KEY("service_id","tool_name","key")
);
--> statement-breakpoint
CREATE TABLE "oauth_access_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"family_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"service_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_authorization_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"state" text,
	"code_challenge" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_refresh_tokens" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"family_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "personal_access_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"hint" text NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_service_projects" (
	"service_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_service_projects_service_id_project_id_pk" PRIMARY KEY("service_id","project_id")
);
--> statement-breakpoint
CREATE TABLE "user_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"client_id" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_access" text DEFAULT 'selected' NOT NULL,
	"allow_project_create" boolean DEFAULT false NOT NULL,
	"approval_mode" text DEFAULT 'REQUIRE_APPROVAL' NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "service_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_approval_requests" ADD CONSTRAINT "mcp_approval_requests_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approval_requests" ADD CONSTRAINT "mcp_approval_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approval_requests" ADD CONSTRAINT "mcp_approval_requests_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approval_rules" ADD CONSTRAINT "mcp_approval_rules_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_approval_rules" ADD CONSTRAINT "mcp_approval_rules_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_idempotency" ADD CONSTRAINT "mcp_idempotency_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "personal_access_tokens" ADD CONSTRAINT "personal_access_tokens_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_projects" ADD CONSTRAINT "user_service_projects_service_id_user_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."user_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_service_projects" ADD CONSTRAINT "user_service_projects_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_services" ADD CONSTRAINT "user_services_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_approval_requests_user_idx" ON "mcp_approval_requests" USING btree ("user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "mcp_approval_requests_service_idx" ON "mcp_approval_requests" USING btree ("service_id","arguments_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_approval_rules_uq" ON "mcp_approval_rules" USING btree ("service_id","project_id","action_key");--> statement-breakpoint
CREATE INDEX "oauth_access_tokens_family_idx" ON "oauth_access_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "oauth_refresh_tokens_family_idx" ON "oauth_refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "personal_access_tokens_hash_uq" ON "personal_access_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "user_services_user_idx" ON "user_services" USING btree ("user_id","created_at");