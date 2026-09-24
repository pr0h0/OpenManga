ALTER TABLE "mcp_idempotency" ALTER COLUMN "result" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_idempotency" ADD COLUMN "state" text DEFAULT 'completed' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_idempotency" ADD COLUMN "approval_request_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_approval_requests_pending_uq" ON "mcp_approval_requests" USING btree ("service_id","tool_name","arguments_hash") WHERE "mcp_approval_requests"."status" = 'pending';