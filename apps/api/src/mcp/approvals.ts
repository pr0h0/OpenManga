import {
  and,
  desc,
  eq,
  gt,
  lt,
  mcpApprovalRequests,
  mcpApprovalRules,
  mcpIdempotency,
  projectMembers,
  projects,
  sql,
} from "@openmanga/db";
import { agentContext, recordAudit } from "@openmanga/services";
import type { Deps } from "../context.ts";
import { loadActor, type McpActor, serviceMayAccess } from "./context.ts";
import {
  type Classification,
  type McpTool,
  PARKED,
  type ToolContext,
  type ToolOutput,
  toolContext,
} from "./registry.ts";
import { argsHash, asToolError, type McpToolError, toolError } from "./runtime.ts";

type ApprovalRow = typeof mcpApprovalRequests.$inferSelect;

/** What every tool call resolves to, before it is shaped into MCP content. */
export type ToolRun = {
  status: "completed" | "pending_approval";
  data?: unknown;
  links?: Record<string, string>;
  content?: ToolOutput["content"];
  approval?: ReturnType<typeof pendingView>;
};

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const POLL_AFTER_SECONDS = 15;

let toolsByName: Map<string, McpTool> = new Map();
/** The server registers its tool list here once, so a parked request can find its tool again when approved. */
export function setToolIndex(tools: McpTool[]) {
  toolsByName = new Map(tools.map((t) => [t.name, t]));
}

export const approvalUrl = (deps: Deps, id: string) => deps.urls.appUrl("agents", { tab: "pending", request: id });

function pendingView(deps: Deps, r: ApprovalRow) {
  return {
    approvalRequestId: r.id,
    action: r.actionKey,
    projectId: r.projectId,
    summary: r.summary,
    sensitivity: r.sensitivity,
    estimatedCostUsd: typeof r.estimate?.estimatedUsd === "number" ? r.estimate.estimatedUsd : null,
    expiresAt: r.expiresAt.toISOString(),
    pollAfterSeconds: POLL_AFTER_SECONDS,
    approvalUrl: approvalUrl(deps, r.id),
  };
}

const stripKey = (args: Record<string, unknown>) => {
  const { idempotencyKey: _k, ...rest } = args;
  return rest;
};

/** Marks pending requests past their deadline as expired (lazily: whenever anything looks at them). */
export async function expireApprovals(deps: Deps) {
  await deps.db
    .update(mcpApprovalRequests)
    .set({ status: "expired" })
    .where(and(eq(mcpApprovalRequests.status, "pending"), lt(mcpApprovalRequests.expiresAt, new Date())));
}

function scopeGate(tool: McpTool, args: Record<string, unknown>, actor: McpActor) {
  const needed = tool.scopesFor ? tool.scopesFor(args as never) : tool.scopes;
  const missing = needed.filter((s) => !actor.scopes.has(s));
  if (missing.length)
    throw toolError(
      403,
      "scope_missing",
      `This connection lacks the ${missing.join(", ")} scope${missing.length > 1 ? "s" : ""}.`,
      {
        required: needed,
        missing,
      },
    );
}

/**
 * Runs one tool call for an actor: scope gate, idempotency replay, classification, the approval decision, then
 * the handler. Errors propagate as {@link McpToolError}; a parked call is a normal result with status
 * `pending_approval`.
 */
export async function runTool(
  deps: Deps,
  actor: McpActor,
  tool: McpTool,
  rawArgs: Record<string, unknown>,
  requestId: string,
): Promise<ToolRun> {
  const args = tool.input.parse(rawArgs) as Record<string, unknown>;
  try {
    scopeGate(tool, args, actor);
  } catch (e) {
    await recordAudit(deps.db, {
      userId: actor.user.id,
      action: "mcp.scope_denied",
      targetType: "mcp_tool",
      metadata: { tool: tool.name, missing: (e as McpToolError).details },
      requestId,
    });
    throw e;
  }
  const ctx = toolContext(deps, actor, requestId, false);
  const key = typeof args.idempotencyKey === "string" ? args.idempotencyKey : null;
  const hash = argsHash(stripKey(args));
  if (key) {
    const [prior] = await deps.db
      .select()
      .from(mcpIdempotency)
      .where(
        and(
          eq(mcpIdempotency.serviceId, actor.serviceId),
          eq(mcpIdempotency.toolName, tool.name),
          eq(mcpIdempotency.key, key),
          gt(mcpIdempotency.expiresAt, new Date()),
        ),
      );
    if (prior) {
      if (prior.argumentsHash !== hash)
        throw toolError(409, "idempotency_conflict", "This idempotencyKey was already used with different arguments.");
      const stored = prior.result as ToolRun;
      if (stored.status === "pending_approval" && stored.approval)
        return approvalRun(deps, actor.serviceId, stored.approval.approvalRequestId);
      return stored;
    }
  }

  const cls: Classification = tool.classify
    ? await tool.classify(args as never, ctx)
    : { sensitivity: "read", actionKey: tool.name, projectId: null, summary: tool.title };

  // The project a call acts in is derived from its target, never trusted from the caller; it must be one the user
  // belongs to and the connection was granted, before anything is parked or run.
  if (cls.projectId) await assertProjectVisible(deps, actor, cls.projectId);

  if (PARKED.has(cls.sensitivity) && actor.approvalMode === "REQUIRE_APPROVAL") {
    const rule = cls.projectId
      ? (
          await deps.db
            .select()
            .from(mcpApprovalRules)
            .where(
              and(
                eq(mcpApprovalRules.serviceId, actor.serviceId),
                eq(mcpApprovalRules.projectId, cls.projectId),
                eq(mcpApprovalRules.actionKey, cls.actionKey),
              ),
            )
        )[0]
      : undefined;
    if (rule?.decision === "DENY")
      throw toolError(
        403,
        "approval_denied_by_rule",
        `The user has chosen to always deny "${cls.actionKey}" for this connection in this project. Do not retry; ask the user if they want to change that in OpenManga.`,
        { action: cls.actionKey, projectId: cls.projectId },
      );
    if (rule?.decision !== "ALLOW") {
      const run = await park(deps, actor, tool, args, hash, key, cls, requestId);
      if (key) await remember(deps, actor.serviceId, tool.name, key, hash, run);
      return run;
    }
  }

  const out = await tool.handler(args as never, ctx);
  const run: ToolRun = { status: "completed", data: out.data, links: out.links, content: out.content };
  if (key) await remember(deps, actor.serviceId, tool.name, key, hash, { ...run, content: undefined });
  return run;
}

async function assertProjectVisible(deps: Deps, actor: McpActor, projectId: string) {
  const [row] = await deps.db
    .select({ owner: projects.ownerUserId, member: projectMembers.userId })
    .from(projects)
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, actor.user.id)))
    .where(eq(projects.id, projectId));
  if (!row || (!row.member && row.owner !== actor.user.id)) throw toolError(404, "not_found", "Project not found");
  if (!serviceMayAccess(actor, projectId)) {
    await recordAudit(deps.db, {
      userId: actor.user.id,
      projectId,
      action: "mcp.project_denied",
      targetType: "project",
    });
    throw toolError(403, "project_not_granted", "This connection has not been granted access to this project");
  }
}

async function remember(deps: Deps, serviceId: string, toolName: string, key: string, hash: string, run: ToolRun) {
  const values = {
    serviceId,
    toolName,
    key,
    argumentsHash: hash,
    result: run as Record<string, unknown>,
    expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_MS),
  };
  await deps.db
    .insert(mcpIdempotency)
    .values(values)
    .onConflictDoUpdate({
      target: [mcpIdempotency.serviceId, mcpIdempotency.toolName, mcpIdempotency.key],
      set: values,
    });
}

async function park(
  deps: Deps,
  actor: McpActor,
  tool: McpTool,
  args: Record<string, unknown>,
  hash: string,
  key: string | null,
  cls: Classification,
  requestId: string,
): Promise<ToolRun> {
  await expireApprovals(deps);
  // The same call already waiting: hand back that request instead of queueing a duplicate for the user.
  const [same] = await deps.db
    .select()
    .from(mcpApprovalRequests)
    .where(
      and(
        eq(mcpApprovalRequests.serviceId, actor.serviceId),
        eq(mcpApprovalRequests.argumentsHash, hash),
        eq(mcpApprovalRequests.toolName, tool.name),
        eq(mcpApprovalRequests.status, "pending"),
      ),
    );
  if (same) return { status: "pending_approval", approval: pendingView(deps, same) };
  const [row] = await deps.db
    .insert(mcpApprovalRequests)
    .values({
      serviceId: actor.serviceId,
      userId: actor.user.id,
      projectId: cls.projectId,
      toolName: tool.name,
      actionKey: cls.actionKey,
      sensitivity: cls.sensitivity,
      summary: cls.summary.slice(0, 2000),
      arguments: args,
      argumentsHash: hash,
      idempotencyKey: key,
      targetSnapshot: cls.target === undefined ? null : { hash: argsHash(cls.target), value: cls.target as never },
      estimate: cls.estimate ?? null,
      expiresAt: new Date(Date.now() + deps.config.MCP_APPROVAL_TTL_MINUTES * 60_000),
    })
    .returning();
  await recordAudit(deps.db, {
    userId: actor.user.id,
    projectId: cls.projectId,
    action: "mcp.approval_requested",
    targetType: "mcp_approval_request",
    targetId: row!.id,
    metadata: { tool: tool.name, actionKey: cls.actionKey, sensitivity: cls.sensitivity },
    requestId,
  });
  return { status: "pending_approval", approval: pendingView(deps, row!) };
}

/** The request as an agent sees it when polling: only ever its own connection's. */
export async function approvalRun(deps: Deps, serviceId: string, id: string): Promise<ToolRun> {
  await expireApprovals(deps);
  const [r] = await deps.db
    .select()
    .from(mcpApprovalRequests)
    .where(and(eq(mcpApprovalRequests.id, id), eq(mcpApprovalRequests.serviceId, serviceId)));
  if (!r) throw toolError(404, "not_found", "Approval request not found");
  if (r.status === "pending") return { status: "pending_approval", approval: pendingView(deps, r) };
  return { status: "completed", data: approvalView(deps, r) };
}

/** A request for the agent or the UI. The stored result is the original tool's result, returned once it ran. */
export function approvalView(deps: Deps, r: ApprovalRow) {
  return {
    id: r.id,
    status: r.status,
    tool: r.toolName,
    action: r.actionKey,
    projectId: r.projectId,
    summary: r.summary,
    sensitivity: r.sensitivity,
    estimate: r.estimate,
    decisionReason: r.decisionReason,
    result: r.result,
    error: r.error,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
    decidedAt: r.decidedAt?.toISOString() ?? null,
    executedAt: r.executedAt?.toISOString() ?? null,
    approvalUrl: approvalUrl(deps, r.id),
    next:
      r.status === "executed"
        ? "The action ran. Continue from `result`; do not call the original tool again."
        : r.status === "denied"
          ? "The user denied this. Respect it and do not retry the same action."
          : r.status === "expired"
            ? "Nobody decided in time. Propose the action again only if it is still needed."
            : r.status === "stale"
              ? "What this action targeted changed before it was approved. Re-read the target before proposing it again."
              : r.status === "failed"
                ? "It was approved but failed when it ran; see `error`."
                : "Waiting for the user.",
  };
}

async function setRule(deps: Deps, r: ApprovalRow, decision: "ALLOW" | "DENY") {
  if (!r.projectId) return;
  await deps.db
    .insert(mcpApprovalRules)
    .values({ serviceId: r.serviceId, projectId: r.projectId, actionKey: r.actionKey, decision, sourceRequestId: r.id })
    .onConflictDoUpdate({
      target: [mcpApprovalRules.serviceId, mcpApprovalRules.projectId, mcpApprovalRules.actionKey],
      set: { decision, sourceRequestId: r.id, updatedAt: new Date() },
    });
}

/**
 * The user's decision on a parked request. Approving re-checks everything a fresh call would (the user and the
 * connection still active, the scopes and project still granted, the target unchanged) and then runs the stored
 * call exactly once: the status moves from `pending` in one conditional update, so a double click cannot run it
 * twice.
 */
export async function decideApproval(
  deps: Deps,
  userId: string,
  id: string,
  d: { decision: "approve" | "deny"; remember: boolean; reason?: string },
  requestId: string,
) {
  await expireApprovals(deps);
  const [r] = await deps.db
    .select()
    .from(mcpApprovalRequests)
    .where(and(eq(mcpApprovalRequests.id, id), eq(mcpApprovalRequests.userId, userId)));
  if (!r) return null;
  if (r.status !== "pending") throw toolError(409, "conflict", `This request is already ${r.status}.`);
  const finish = async (set: Partial<ApprovalRow>) => {
    const [row] = Object.keys(set).length
      ? await deps.db.update(mcpApprovalRequests).set(set).where(eq(mcpApprovalRequests.id, id)).returning()
      : await deps.db.select().from(mcpApprovalRequests).where(eq(mcpApprovalRequests.id, id));
    if (r.idempotencyKey && row && row.status !== "approved") {
      const run: ToolRun =
        row.status === "executed"
          ? { status: "completed", ...(row.result as object) }
          : { status: "completed", data: approvalView(deps, row) };
      await deps.db
        .update(mcpIdempotency)
        .set({ result: run as Record<string, unknown> })
        .where(
          and(
            eq(mcpIdempotency.serviceId, r.serviceId),
            eq(mcpIdempotency.toolName, r.toolName),
            eq(mcpIdempotency.key, r.idempotencyKey),
          ),
        );
    }
    return row!;
  };
  const audit = (action: string, metadata: Record<string, unknown> = {}) =>
    recordAudit(deps.db, {
      userId,
      projectId: r.projectId,
      action,
      targetType: "mcp_approval_request",
      targetId: r.id,
      serviceId: r.serviceId,
      metadata: { tool: r.toolName, actionKey: r.actionKey, ...metadata },
      requestId,
    });

  const [claimed] = await deps.db
    .update(mcpApprovalRequests)
    .set({
      status: d.decision === "approve" ? "approved" : "denied",
      decidedAt: new Date(),
      decisionReason: d.reason ?? null,
    })
    .where(and(eq(mcpApprovalRequests.id, id), eq(mcpApprovalRequests.status, "pending")))
    .returning();
  if (!claimed) throw toolError(409, "conflict", "This request was decided already.");

  if (d.decision === "deny") {
    if (d.remember) await setRule(deps, r, "DENY");
    await audit("mcp.approval_denied", { remember: d.remember });
    return finish({});
  }
  if (d.remember) await setRule(deps, r, "ALLOW");
  await audit("mcp.approval_approved", { remember: d.remember });

  const fail = (code: string, message: string, status: "failed" | "stale" = "failed") =>
    finish({ status, error: { code, message } });
  const tool = toolsByName.get(r.toolName);
  if (!tool) return fail("unknown_tool", "This tool no longer exists.");
  const actor = await loadActor(deps.db, r.serviceId);
  if (!actor) return fail("connection_inactive", "The connection was revoked or its user disabled while waiting.");
  if (r.projectId && !serviceMayAccess(actor, r.projectId))
    return fail("project_not_granted", "The connection lost access to this project while waiting.");
  try {
    scopeGate(tool, r.arguments, actor);
  } catch (e) {
    return fail("scope_missing", (e as Error).message);
  }

  return agentContext.run({ serviceId: actor.serviceId, serviceName: actor.serviceName }, async () => {
    const ctx: ToolContext = toolContext(deps, actor, requestId, true);
    const args = tool.input.parse(r.arguments) as Record<string, unknown>;
    // Freshness: the target as it is now must be what the user was shown.
    try {
      const now = tool.classify ? await tool.classify(args as never, ctx) : null;
      const before = r.targetSnapshot as { hash?: string } | null;
      if (before?.hash && (!now || now.target === undefined || argsHash(now.target) !== before.hash)) {
        await audit("mcp.approval_stale");
        return fail("stale", "The target changed after this was requested, so the old request was not run.", "stale");
      }
    } catch (e) {
      const err = asToolError(e);
      if (err.status === 404) {
        await audit("mcp.approval_stale");
        return fail("stale", "The target no longer exists.", "stale");
      }
      return finish({
        status: "failed",
        error: { code: err.code, message: err.message, details: err.details } as never,
      });
    }
    try {
      const out = await tool.handler(args as never, ctx);
      await audit("mcp.approval_executed");
      return finish({
        status: "executed",
        executedAt: new Date(),
        result: { data: out.data, links: out.links } as Record<string, unknown>,
      });
    } catch (e) {
      const err = asToolError(e);
      return finish({
        status: "failed",
        error: { code: err.code, message: err.message, details: err.details } as never,
      });
    }
  });
}

/** The user's approvals list for the UI, newest first. */
export async function listApprovals(deps: Deps, userId: string, which: "pending" | "history", limit = 100) {
  await expireApprovals(deps);
  return deps.db
    .select()
    .from(mcpApprovalRequests)
    .where(
      and(
        eq(mcpApprovalRequests.userId, userId),
        which === "pending"
          ? eq(mcpApprovalRequests.status, "pending")
          : sql`${mcpApprovalRequests.status} <> 'pending'`,
      ),
    )
    .orderBy(desc(mcpApprovalRequests.createdAt))
    .limit(limit);
}
