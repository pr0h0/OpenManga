import {
  and,
  desc,
  eq,
  inArray,
  isNull,
  mcpApprovalRequests,
  mcpApprovalRules,
  personalAccessTokens,
  projectMembers,
  projects,
  userServiceProjects,
  userServices,
} from "@openmanga/db";
import { asPatch } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiError, body, clientIp, notFound, user, uuidParam } from "../lib/http.ts";
import { approvalView, decideApproval, listApprovals } from "../mcp/approvals.ts";
import { hashMcpToken, mcpUrls, newToken, TOKEN_PREFIX } from "../mcp/context.ts";
import { approveAuthorization, denyAuthorization, openAuthorizationRequest, revokeTokens } from "../mcp/oauth.ts";
import { McpToolError } from "../mcp/runtime.ts";
import { ALL_SCOPES, MCP_SCOPES, normalizeScopes } from "../mcp/scopes.ts";

/**
 * Agent access, managed by the user in the web app (session + CSRF, like the rest of /api): connections and
 * their restrictions, personal access tokens, OAuth consent, approvals and remembered rules. None of this is
 * reachable through MCP itself.
 */
export const agentRoutes = new Hono<AppEnv>();

const Grant = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1),
  projectAccess: z.enum(["all", "selected"]),
  projectIds: z.array(z.string().uuid()).max(500).default([]),
  allowProjectCreate: z.boolean().default(false),
  approvalMode: z.enum(["ALLOW_ALL", "REQUIRE_APPROVAL"]).default("REQUIRE_APPROVAL"),
});

/** Only projects the user belongs to can be granted. */
async function ownedProjectIds(c: Context<AppEnv>, ids: string[]) {
  if (!ids.length) return [];
  const mine = await c
    .get("deps")
    .db.select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.userId, user(c).id), inArray(projectMembers.projectId, ids)));
  return mine.map((m) => m.id);
}

async function setProjects(c: Context<AppEnv>, serviceId: string, access: "all" | "selected", ids: string[]) {
  const db = c.get("deps").db;
  await db.delete(userServiceProjects).where(eq(userServiceProjects.serviceId, serviceId));
  if (access === "selected") {
    const keep = await ownedProjectIds(c, ids);
    if (keep.length) await db.insert(userServiceProjects).values(keep.map((projectId) => ({ serviceId, projectId })));
  }
}

async function ownService(c: Context<AppEnv>, id: string) {
  const [s] = await c
    .get("deps")
    .db.select()
    .from(userServices)
    .where(and(eq(userServices.id, id), eq(userServices.userId, user(c).id)));
  if (!s) throw notFound("Connection");
  return s;
}

const decisionError = (e: unknown) => {
  if (e instanceof McpToolError) throw new ApiError(e.status as 409, e.code, e.message);
  throw e;
};

agentRoutes.get("/info", (c) => {
  const u = mcpUrls(c.get("deps").config);
  return c.json({
    enabled: c.get("deps").config.MCP_ENABLED,
    endpoint: u.resource,
    issuer: u.issuer,
    scopes: Object.entries(MCP_SCOPES).map(([scope, description]) => ({ scope, description })),
    approvalTtlMinutes: c.get("deps").config.MCP_APPROVAL_TTL_MINUTES,
  });
});

agentRoutes.get("/connections", async (c) => {
  const db = c.get("deps").db;
  const rows = await db
    .select()
    .from(userServices)
    .where(eq(userServices.userId, user(c).id))
    .orderBy(desc(userServices.createdAt))
    .limit(200);
  const ids = rows.map((r) => r.id);
  const grants = ids.length
    ? await db
        .select({ s: userServiceProjects.serviceId, id: projects.id, title: projects.title })
        .from(userServiceProjects)
        .innerJoin(projects, eq(projects.id, userServiceProjects.projectId))
        .where(inArray(userServiceProjects.serviceId, ids))
    : [];
  const tokens = ids.length
    ? await db
        .select({
          s: personalAccessTokens.serviceId,
          id: personalAccessTokens.id,
          hint: personalAccessTokens.hint,
          expiresAt: personalAccessTokens.expiresAt,
          lastUsedAt: personalAccessTokens.lastUsedAt,
          revokedAt: personalAccessTokens.revokedAt,
          createdAt: personalAccessTokens.createdAt,
        })
        .from(personalAccessTokens)
        .where(inArray(personalAccessTokens.serviceId, ids))
    : [];
  return c.json({
    connections: rows.map((s) => ({
      ...s,
      projects: grants.filter((g) => g.s === s.id).map(({ id, title }) => ({ id, title })),
      // Token values are never stored; the hint is the last few characters, to tell tokens apart.
      tokens: tokens.filter((t) => t.s === s.id).map(({ s: _s, ...t }) => t),
    })),
  });
});

const NewToken = Grant.extend({ expiresInDays: z.number().int().min(1).max(3650).nullable().default(null) });
agentRoutes.post("/tokens", async (c) => {
  const input = await body(c, NewToken);
  const deps = c.get("deps");
  const token = newToken(TOKEN_PREFIX.pat);
  const [service] = await deps.db
    .insert(userServices)
    .values({
      userId: user(c).id,
      kind: "pat",
      name: input.name,
      scopes: normalizeScopes(input.scopes),
      projectAccess: input.projectAccess,
      allowProjectCreate: input.allowProjectCreate,
      approvalMode: input.approvalMode,
    })
    .returning();
  await setProjects(c, service!.id, input.projectAccess, input.projectIds);
  await deps.db.insert(personalAccessTokens).values({
    serviceId: service!.id,
    tokenHash: hashMcpToken(deps.config, token),
    hint: token.slice(-4),
    expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
  });
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: "mcp.pat_created",
    targetType: "user_service",
    targetId: service!.id,
    serviceId: service!.id,
    metadata: {
      name: input.name,
      scopes: input.scopes,
      projectAccess: input.projectAccess,
      approvalMode: input.approvalMode,
    },
    ip: clientIp(c),
    requestId: c.get("requestId"),
  });
  // The only time the token is ever returned.
  return c.json({ connection: service, token }, 201);
});

agentRoutes.patch("/connections/:id", async (c) => {
  const s = await ownService(c, uuidParam(c, "id"));
  if (s.revokedAt) throw new ApiError(409, "conflict", "This connection is revoked");
  const input = await body(c, asPatch(Grant));
  const deps = c.get("deps");
  const [row] = await deps.db
    .update(userServices)
    .set({
      ...(input.name ? { name: input.name } : {}),
      ...(input.scopes ? { scopes: normalizeScopes(input.scopes) } : {}),
      ...(input.projectAccess ? { projectAccess: input.projectAccess } : {}),
      ...(input.allowProjectCreate !== undefined ? { allowProjectCreate: input.allowProjectCreate } : {}),
      ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
      updatedAt: new Date(),
    })
    .where(eq(userServices.id, s.id))
    .returning();
  if (input.projectAccess || input.projectIds) await setProjects(c, s.id, row!.projectAccess, input.projectIds ?? []);
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: "mcp.connection_updated",
    targetType: "user_service",
    targetId: s.id,
    serviceId: s.id,
    metadata: input,
    requestId: c.get("requestId"),
  });
  return c.json({ connection: row });
});

agentRoutes.post("/connections/:id/revoke", async (c) => {
  const s = await ownService(c, uuidParam(c, "id"));
  const deps = c.get("deps");
  const now = new Date();
  await deps.db
    .update(userServices)
    .set({ revokedAt: now })
    .where(and(eq(userServices.id, s.id), isNull(userServices.revokedAt)));
  await deps.db
    .update(personalAccessTokens)
    .set({ revokedAt: now })
    .where(and(eq(personalAccessTokens.serviceId, s.id), isNull(personalAccessTokens.revokedAt)));
  await revokeTokens(deps, { serviceId: s.id });
  // Nothing parked for a revoked connection can run any more.
  await deps.db
    .update(mcpApprovalRequests)
    .set({ status: "expired" })
    .where(and(eq(mcpApprovalRequests.serviceId, s.id), eq(mcpApprovalRequests.status, "pending")));
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: s.kind === "pat" ? "mcp.pat_revoked" : "mcp.connection_revoked",
    targetType: "user_service",
    targetId: s.id,
    serviceId: s.id,
    metadata: { name: s.name },
    ip: clientIp(c),
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- approvals

async function approvalRows(c: Context<AppEnv>, rows: (typeof mcpApprovalRequests.$inferSelect)[]) {
  const db = c.get("deps").db;
  const sIds = [...new Set(rows.map((r) => r.serviceId))];
  const pIds = [...new Set(rows.map((r) => r.projectId).filter((p): p is string => Boolean(p)))];
  const services = sIds.length
    ? await db
        .select({ id: userServices.id, name: userServices.name })
        .from(userServices)
        .where(inArray(userServices.id, sIds))
    : [];
  const ps = pIds.length
    ? await db.select({ id: projects.id, title: projects.title }).from(projects).where(inArray(projects.id, pIds))
    : [];
  return rows.map((r) => ({
    ...approvalView(c.get("deps"), r),
    arguments: r.arguments,
    connection: services.find((s) => s.id === r.serviceId) ?? null,
    project: ps.find((p) => p.id === r.projectId) ?? null,
  }));
}

agentRoutes.get("/approvals", async (c) => {
  const view = c.req.query("view") === "history" ? "history" : "pending";
  const rows = await listApprovals(c.get("deps"), user(c).id, view);
  return c.json({ approvals: await approvalRows(c, rows) });
});

const Decide = z.object({
  decision: z.enum(["approve", "deny"]),
  remember: z.boolean().default(false),
  reason: z.string().trim().max(1000).optional(),
});
agentRoutes.post("/approvals/:id/decide", async (c) => {
  const input = await body(c, Decide);
  const row = await decideApproval(c.get("deps"), user(c).id, uuidParam(c, "id"), input, c.get("requestId")).catch(
    decisionError,
  );
  if (!row) throw notFound("Approval request");
  return c.json({ approval: (await approvalRows(c, [row]))[0] });
});

agentRoutes.get("/rules", async (c) => {
  const db = c.get("deps").db;
  const rows = await db
    .select({ rule: mcpApprovalRules, connection: userServices.name, project: projects.title })
    .from(mcpApprovalRules)
    .innerJoin(userServices, eq(userServices.id, mcpApprovalRules.serviceId))
    .innerJoin(projects, eq(projects.id, mcpApprovalRules.projectId))
    .where(eq(userServices.userId, user(c).id))
    .orderBy(desc(mcpApprovalRules.updatedAt));
  return c.json({ rules: rows.map((r) => ({ ...r.rule, connection: r.connection, project: r.project })) });
});

async function ownRule(c: Context<AppEnv>, id: string) {
  const [r] = await c
    .get("deps")
    .db.select({ rule: mcpApprovalRules })
    .from(mcpApprovalRules)
    .innerJoin(userServices, eq(userServices.id, mcpApprovalRules.serviceId))
    .where(and(eq(mcpApprovalRules.id, id), eq(userServices.userId, user(c).id)));
  if (!r) throw notFound("Rule");
  return r.rule;
}

agentRoutes.patch("/rules/:id", async (c) => {
  const rule = await ownRule(c, uuidParam(c, "id"));
  const { decision } = await body(c, z.object({ decision: z.enum(["ALLOW", "DENY"]) }));
  const [row] = await c
    .get("deps")
    .db.update(mcpApprovalRules)
    .set({ decision, updatedAt: new Date() })
    .where(eq(mcpApprovalRules.id, rule.id))
    .returning();
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: rule.projectId,
    action: "mcp.rule_changed",
    targetType: "mcp_approval_rule",
    targetId: rule.id,
    serviceId: rule.serviceId,
    metadata: { actionKey: rule.actionKey, decision },
    requestId: c.get("requestId"),
  });
  return c.json({ rule: row });
});

agentRoutes.delete("/rules/:id", async (c) => {
  const rule = await ownRule(c, uuidParam(c, "id"));
  await c.get("deps").db.delete(mcpApprovalRules).where(eq(mcpApprovalRules.id, rule.id));
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: rule.projectId,
    action: "mcp.rule_deleted",
    targetType: "mcp_approval_rule",
    targetId: rule.id,
    serviceId: rule.serviceId,
    metadata: { actionKey: rule.actionKey, decision: rule.decision },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- OAuth consent

agentRoutes.get("/consent/:requestId", async (c) => {
  const req = await openAuthorizationRequest(c.get("deps"), uuidParam(c, "requestId"));
  if (!req) throw notFound("Authorization request (it may have expired; start connecting again from your app)");
  const redirect = new URL(req.r.redirectUri);
  return c.json({
    request: {
      id: req.r.id,
      client: { id: req.client.id, name: req.client.name, kind: req.client.kind },
      redirectHost: redirect.host,
      scopes: req.r.scopes.map((s) => ({ scope: s, description: MCP_SCOPES[s as keyof typeof MCP_SCOPES] ?? s })),
      expiresAt: req.r.expiresAt,
    },
  });
});

const Consent = z.discriminatedUnion("approve", [
  z.object({ approve: z.literal(false) }),
  z.object({ approve: z.literal(true), grant: Grant }),
]);
agentRoutes.post("/consent/:requestId", async (c) => {
  const id = uuidParam(c, "requestId");
  const input = await body(c, Consent);
  const deps = c.get("deps");
  const result = input.approve
    ? await approveAuthorization(deps, user(c).id, id, input.grant, (serviceId) =>
        setProjects(c, serviceId, input.grant.projectAccess, input.grant.projectIds),
      )
    : await denyAuthorization(deps, id);
  if (!result) throw notFound("Authorization request (it may have expired or been answered already)");
  return c.json({ redirectTo: result.redirectTo });
});
