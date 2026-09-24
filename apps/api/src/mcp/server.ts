import {
  createMcpHandler,
  hostHeaderValidationResponse,
  type McpHttpHandler,
  McpServer,
  originValidationResponse,
} from "@modelcontextprotocol/server";
import { agentContext } from "@openmanga/services";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { ApiError, notFound } from "../lib/http.ts";
import { runTool, setToolIndex, type ToolRun } from "./approvals.ts";
import { authenticateBearer, bearerChallenge } from "./auth.ts";
import { type McpActor, mcpAllowedHosts } from "./context.ts";
import { annotationsFor, type McpTool, ResultEnvelope } from "./registry.ts";
import { asToolError } from "./runtime.ts";
import { MCP_TOOLS } from "./tools/index.ts";

export const MCP_SERVER_VERSION = "1.0.0";

setToolIndex(MCP_TOOLS);

export const SERVER_INSTRUCTIONS = `OpenManga turns stories into manga, webtoons and narrated videos. You act as the signed-in user, limited to the scopes and projects they granted this connection.

Work top-down and in small pieces: project → story → chapters → scenes → pages → panels. A project can have 20+ chapters and 1,000+ panels; read and change one chapter or page at a time, and page through lists.

Asynchronous work: tools that start AI work return a job immediately. Poll it with get_job (not in a tight loop; wait several seconds between polls). Status queued/processing means wait; awaiting_input means a manual (paste-mode) job is waiting for your answer; completed/failed/cancelled are final.

Manual (paste) mode needs no provider key: pass ai: { manual: true } to a text tool. When the job is awaiting_input, call get_manual_prompt, write an answer that satisfies the schema it shows (get_answer_schema explains every schema), and send it with submit_manual_answer. A chapter plan asks several questions in turn (ChapterOutline, then one ScenePages per scene): repeat until the job completes. A rejected answer leaves the job awaiting_input with lastError; fix only what it names and resubmit.

Spending: image generation, provider-backed text, vision and cloud speech use the user's own provider keys and budget. Estimate bulk work with estimate_bulk_generation before run_bulk_generation. Never try to get around budget_exceeded or credentials_required; tell the user.

Approvals: some calls return status "pending_approval" instead of running. That is not an error. Tell the user an approval is waiting and give them approvalUrl. Do not call the original tool again. Check later with get_approval_request (not in a loop); when it is executed, continue from its result. When denied, respect it. When expired, propose the action again only if still needed. When stale, re-read the target first.

Errors carry a code: scope_missing and project_not_granted mean this connection was not given that access (ask the user to change it in OpenManga → Agent access); approval_denied_by_rule means the user always denies that action here; conflict usually means an approved/locked version or a job in the wrong state (create a new draft version rather than editing a locked one).`;

function toContent(run: ToolRun, requestId: string) {
  const structured = {
    ok: true as const,
    status: run.status,
    ...(run.data !== undefined ? { data: run.data } : {}),
    ...(run.approval ? { approval: run.approval } : {}),
    requestId,
    ...(run.links ? { links: run.links } : {}),
  };
  const lead =
    run.status === "pending_approval"
      ? `Approval required: ${run.approval?.summary}. Ask the user to approve it at ${run.approval?.approvalUrl}, then check get_approval_request with id ${run.approval?.approvalRequestId}. Do not repeat this call.\n`
      : "";
  return {
    content: [{ type: "text" as const, text: lead + JSON.stringify(structured) }, ...(run.content ?? [])],
    structuredContent: structured,
  };
}

function toErrorResult(deps: Deps, actor: McpActor, e: unknown, requestId: string) {
  const err = asToolError(e);
  if (err.status >= 500 && err.code === "internal_error") deps.logger.error("mcp tool failed", { error: e, requestId });
  const error = {
    code: err.code,
    message: err.message,
    status: err.status,
    ...(err.details !== undefined ? { details: err.details } : {}),
    ...(err.retryAfterSeconds ? { retryAfterSeconds: err.retryAfterSeconds } : {}),
    requestId,
  };
  const result: {
    isError: true;
    content: { type: "text"; text: string }[];
    _meta?: Record<string, unknown>;
  } = { isError: true, content: [{ type: "text", text: JSON.stringify({ ok: false, error }) }] };
  // OAuth clients can step up: the challenge names the scopes to ask the user for (ChatGPT reads it from _meta).
  if (err.code === "scope_missing" && actor.serviceKind === "oauth") {
    const missing = ((err.details as { missing?: string[] })?.missing ?? []) as string[];
    const scope = [...new Set([...actor.scopes, ...missing])].join(" ");
    result._meta = {
      "mcp/www_authenticate": [bearerChallenge(deps, { code: "insufficient_scope", description: err.message, scope })],
    };
  }
  return result;
}

const CREATES_PROJECTS = new Set(["create_project", "duplicate_project"]);

/**
 * Whether a connection is shown a tool. An access token lists only what it can ever call (a smaller, clearer
 * catalogue, and a PAT has no way to gain scopes mid-session). An OAuth connection sees every tool its settings
 * allow: its scopes can grow by step-up, which a client only asks for when it sees the tool. Hidden tools are not
 * callable either; the scope gate still applies to the ones shown.
 */
export function visibleTo(tool: McpTool, actor: McpActor) {
  if (CREATES_PROJECTS.has(tool.name) && !actor.allowProjectCreate) return false;
  if (actor.serviceKind !== "pat" || !tool.scopes.length) return true;
  return tool.scopesFor ? tool.scopes.some((s) => actor.scopes.has(s)) : tool.scopes.every((s) => actor.scopes.has(s));
}

function buildServer(deps: Deps, actor: McpActor, requestId: string) {
  const server = new McpServer(
    { name: "openmanga", title: "OpenManga", version: MCP_SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  for (const tool of MCP_TOOLS.filter((t) => visibleTo(t, actor))) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        outputSchema: ResultEnvelope(tool.output),
        annotations: { title: tool.title, ...annotationsFor(tool) },
        _meta: { securitySchemes: [{ type: "oauth2", scopes: tool.scopes }] },
      },
      async (args: unknown) => {
        // One line per call (never the arguments): a tool error travels inside a 200 reply, so without this it would
        // not show up in the logs at all.
        const started = performance.now();
        const log = (level: "info" | "warn", outcome: string, extra: Record<string, unknown> = {}) =>
          deps.logger[level]("mcp tool call", {
            requestId,
            tool: tool.name,
            connection: actor.serviceId,
            outcome,
            latencyMs: Math.round(performance.now() - started),
            ...extra,
          });
        try {
          const run = await runTool(deps, actor, tool, args as Record<string, unknown>, requestId);
          log("info", run.status, run.approval ? { approval: run.approval.approvalRequestId } : {});
          return toContent(run, requestId);
        } catch (e) {
          const err = asToolError(e);
          log("warn", "error", { code: err.code, status: err.status, message: err.message.slice(0, 300) });
          return toErrorResult(deps, actor, e, requestId);
        }
      },
    );
  }
  return server;
}

const handlers = new WeakMap<Deps, McpHttpHandler>();
function handlerFor(deps: Deps) {
  let h = handlers.get(deps);
  if (!h) {
    h = createMcpHandler(({ authInfo }) => {
      const extra = authInfo?.extra as { actor: McpActor; requestId: string };
      return buildServer(deps, extra.actor, extra.requestId);
    });
    handlers.set(deps, h);
  }
  return h;
}

export const mcpRoutes = new Hono<AppEnv>();

mcpRoutes.all("/mcp", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.MCP_ENABLED) throw notFound("Route");
  // DNS-rebinding protection (the SDK's own checks): only the configured public hosts, and localhost, are answered.
  const hosts = mcpAllowedHosts(deps.config);
  const rejected =
    hostHeaderValidationResponse(c.req.raw, hosts) ??
    originValidationResponse(c.req.raw, [...hosts, "chatgpt.com", "chat.openai.com"]);
  if (rejected) return rejected;
  const auth = await authenticateBearer(deps, c.req.header("authorization"));
  if ("error" in auth) {
    c.header(
      "WWW-Authenticate",
      bearerChallenge(
        deps,
        auth.error === "invalid"
          ? { code: "invalid_token", description: "The access token is invalid or expired" }
          : undefined,
      ),
    );
    return c.json(
      { error: { code: "unauthenticated", message: "Bearer token required", requestId: c.get("requestId") } },
      401,
    );
  }
  const { actor } = auth;
  c.set("user", actor.user);
  // Per connection, so one busy agent cannot starve the user's other connections or the browser.
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `om:rl:mcp:${actor.serviceId}:${bucket}`;
  try {
    const n = await deps.redis.incr(key);
    if (n === 1) await deps.redis.expire(key, 61);
    if (n > deps.config.MCP_RATE_LIMIT_PER_MINUTE) {
      c.header("retry-after", "60");
      throw new ApiError(429, "rate_limited", "Too many MCP requests from this connection. Please slow down.");
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
  }
  const requestId = c.get("requestId");
  const res = await agentContext.run({ serviceId: actor.serviceId, serviceName: actor.serviceName }, () =>
    handlerFor(deps).fetch(c.req.raw, {
      authInfo: {
        token: "redacted",
        clientId: actor.clientId ?? `pat:${actor.serviceId}`,
        scopes: [...actor.scopes],
        expiresAt: auth.expiresAt,
        extra: { actor, requestId },
      },
    }),
  );
  // Protocol-level failures (a malformed request, an unknown tool, arguments the SDK rejected before any tool ran)
  // never reach the tool callback's log line; note them here.
  // A GET is a client probing for a standalone event stream, which a stateless server answers 405 by design.
  if (c.req.method !== "GET" && (res.headers.get("content-type") ?? "").includes("json")) {
    const text = await res.clone().text();
    const rejected = text.match(/"error":\{"code":-?\d+,"message":"([^"]{0,300})|Input validation error[^"]{0,300}/);
    if (rejected || res.status >= 400)
      deps.logger.warn("mcp request rejected", {
        requestId,
        connection: actor.serviceId,
        status: res.status,
        message: rejected?.[1] ?? rejected?.[0] ?? text.slice(0, 300),
      });
  }
  return res;
});
