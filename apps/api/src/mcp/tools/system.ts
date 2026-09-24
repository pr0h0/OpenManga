import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/server";
import {
  ANSWER_ASKED_BY,
  ANSWER_FIELD_DOCS,
  ANSWER_SCHEMAS,
  assembleExample,
  type JsonSchema,
  renderInterface,
} from "@openmanga/schemas";
import { z } from "zod";
import { build } from "../../lib/build.ts";
import { openApiSpec } from "../../lib/openapi.ts";
import { MAX_BULK_PANELS } from "../../routes/generations.ts";
import { approvalRun } from "../approvals.ts";
import { mcpUrls } from "../context.ts";
import { defineMcpTool, Passthrough } from "../registry.ts";
import { Uuid } from "./common.ts";

const SCHEMA_NAMES = Object.keys(ANSWER_SCHEMAS) as [keyof typeof ANSWER_SCHEMAS, ...(keyof typeof ANSWER_SCHEMAS)[]];

export const systemTools = [
  defineMcpTool({
    name: "get_server_info",
    title: "Server info",
    description:
      "OpenManga version and build, MCP protocol versions, answer schema names, limits, this connection's granted scopes/projects/approval mode, and the user's saved AI provider keys (ids and kinds only, never secrets) to use in `ai` arguments. Call this first in a session. Read-only.",
    input: z.object({}),
    output: Passthrough,
    scopes: [],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/meta", "GET /api/ai/options"],
    actionKeys: [],
    handler: async (_args, ctx) => {
      const meta = await ctx.invoke<Record<string, unknown>>("GET", "/api/meta");
      const opts = await ctx.invoke<{ credentials: { id: string; kind: string; label: string }[]; mockMode: boolean }>(
        "GET",
        "/api/ai/options",
      );
      const { MCP_SERVER_VERSION } = await import("../server.ts");
      return {
        data: {
          openmanga: { version: build.version, build: build.label, commit: build.sha, builtAt: build.builtAt },
          mcp: {
            serverVersion: MCP_SERVER_VERSION,
            // The SDK serves the 2026-07-28 revision (per-request envelope) and, statelessly, the 2025-era handshake
            // revisions; it does not export the modern one as a constant.
            protocolVersions: { modern: "2026-07-28", legacy: SUPPORTED_PROTOCOL_VERSIONS },
            resource: mcpUrls(ctx.deps.config).resource,
          },
          connection: {
            name: ctx.actor.serviceName,
            kind: ctx.actor.serviceKind,
            scopes: [...ctx.actor.scopes],
            projectAccess: ctx.actor.projectAccess,
            projectIds: ctx.actor.projectAccess === "selected" ? [...ctx.actor.projectIds] : undefined,
            allowProjectCreate: ctx.actor.allowProjectCreate,
            approvalMode: ctx.actor.approvalMode,
            user: { username: ctx.actor.user.username, displayName: ctx.actor.user.displayName },
          },
          answerSchemas: SCHEMA_NAMES,
          ai: {
            mockMode: opts.mockMode,
            savedKeys: opts.credentials.map((k) => ({ id: k.id, kind: k.kind, label: k.label })),
            manualModeAvailable: true,
          },
          limits: {
            maxBulkPanels: MAX_BULK_PANELS,
            bulkApprovalThreshold: ctx.deps.config.MCP_BULK_APPROVAL_THRESHOLD,
            approvalTtlMinutes: ctx.deps.config.MCP_APPROVAL_TTL_MINUTES,
            rateLimitPerMinute: ctx.deps.config.MCP_RATE_LIMIT_PER_MINUTE,
            defaultPageSize: 25,
            maxPageSize: 100,
          },
          layouts: meta.layouts,
          ttsEnabled: meta.ttsEnabled,
        },
        links: { app: ctx.deps.urls.appUrl(), agentAccess: ctx.deps.urls.appUrl("agents") },
      };
    },
  }),

  defineMcpTool({
    name: "get_answer_schema",
    title: "Answer schema",
    description:
      "The live JSON Schema of one answer format a manual (paste-mode) job can ask for, with every field explained, a commented TypeScript interface and a complete valid example. Always from this server's running version. Read-only. get_manual_prompt already includes the format for the exact question being asked; use this to prepare in advance.",
    input: z.object({ name: z.enum(SCHEMA_NAMES) }),
    output: z
      .object({
        name: z.string(),
        askedBy: z.string(),
        jsonSchema: z.record(z.string(), z.unknown()),
        interface: z.string(),
        example: z.unknown(),
      })
      .passthrough(),
    scopes: [],
    sensitivity: "read",
    idempotent: true,
    routes: [],
    actionKeys: [],
    handler: async ({ name }) => {
      const json = z.toJSONSchema(ANSWER_SCHEMAS[name], { io: "input", unrepresentable: "any" }) as JsonSchema;
      const docs = ANSWER_FIELD_DOCS[name];
      return {
        data: {
          name,
          askedBy: ANSWER_ASKED_BY[name].replace(/\*\*/g, ""),
          jsonSchema: json,
          interface: renderInterface(name, json, docs),
          example: assembleExample(json, docs),
        },
      };
    },
  }),

  defineMcpTool({
    name: "describe_api",
    title: "Describe REST API",
    description:
      "Search OpenManga's REST API description (from the live OpenAPI registry) to understand what an operation does and what it accepts. Returns at most 20 matching operations, with schemas only when `includeSchemas` is true. Informational: MCP tools are how you act; there is no generic REST call tool. Read-only.",
    input: z.object({
      tag: z.string().max(40).optional().describe("e.g. projects, stories, chapters, panels, generations, narration"),
      path: z.string().max(200).optional().describe("Substring of the path, e.g. /chapters/"),
      method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).optional(),
      query: z.string().max(100).optional().describe("Words to find in the summary"),
      includeSchemas: z.boolean().default(false),
    }),
    output: z.object({ operations: z.array(Passthrough), total: z.number(), tags: z.array(z.string()) }),
    scopes: [],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/docs/openapi.json"],
    actionKeys: [],
    handler: async (args) => {
      const spec = openApiSpec("") as { paths: Record<string, Record<string, Record<string, unknown>>> };
      const ops: Record<string, unknown>[] = [];
      const tags = new Set<string>();
      const words = (args.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      for (const [p, methods] of Object.entries(spec.paths))
        for (const [m, op] of Object.entries(methods)) {
          const tag = (op.tags as string[])[0]!;
          // Accounts, admin and keys are not an agent's business: not described here either.
          if (/^\/api\/(auth|admin|dev|ai\/credentials)/.test(p)) continue;
          tags.add(tag);
          if (args.tag && tag !== args.tag) continue;
          if (args.path && !p.includes(args.path)) continue;
          if (args.method && m.toUpperCase() !== args.method) continue;
          const summary = String(op.summary);
          if (words.length && !words.every((w) => summary.toLowerCase().includes(w))) continue;
          ops.push({
            method: m.toUpperCase(),
            path: p,
            tag,
            summary,
            ...(args.includeSchemas ? { parameters: op.parameters, requestBody: op.requestBody } : {}),
          });
        }
      return { data: { operations: ops.slice(0, 20), total: ops.length, tags: [...tags].sort() } };
    },
  }),

  defineMcpTool({
    name: "get_approval_request",
    title: "Approval request status",
    description:
      "Check an approval request this connection created (the approvalRequestId from a pending_approval result). Returns pending, executed (with the original tool's saved result — continue from it, do not call the original tool again), denied, expired, stale or failed. Poll only after a reasonable delay or when the user says they decided; never in a tight loop. Read-only.",
    input: z.object({ approvalRequestId: Uuid }),
    output: Passthrough,
    scopes: [],
    sensitivity: "read",
    idempotent: true,
    routes: [],
    actionKeys: [],
    handler: async ({ approvalRequestId }, ctx) => {
      const run = await approvalRun(ctx.deps, ctx.actor.serviceId, approvalRequestId);
      return { data: run.status === "pending_approval" ? { status: "pending", ...run.approval } : run.data };
    },
  }),
];
