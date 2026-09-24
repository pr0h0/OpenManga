import { createHmac, randomBytes } from "node:crypto";
import { getOAuthProtectedResourceMetadataUrl } from "@modelcontextprotocol/server";
import type { SessionUser } from "@openmanga/auth";
import type { AppConfig } from "@openmanga/config";
import {
  and,
  type Database,
  eq,
  isNull,
  type McpApprovalMode,
  type McpProjectAccess,
  userServiceProjects,
  userServices,
  users,
} from "@openmanga/db";
import { type McpScope, normalizeScopes } from "./scopes.ts";

/**
 * Who an MCP call runs as: a user, through one of their connections, with the connection's current restrictions.
 * Always loaded fresh from the database, so a revoked connection, a disabled user or narrowed scopes take effect on
 * the very next call, whatever an older token says.
 */
export type McpActor = {
  user: SessionUser;
  serviceId: string;
  serviceName: string;
  serviceKind: "oauth" | "pat";
  clientId: string | null;
  scopes: Set<McpScope>;
  projectAccess: McpProjectAccess;
  /** The granted projects, when access is `selected`. */
  projectIds: Set<string>;
  allowProjectCreate: boolean;
  approvalMode: McpApprovalMode;
};

/** The service restriction the shared access check applies on top of project membership. */
export type ServiceRestriction = Pick<McpActor, "serviceId" | "projectAccess" | "projectIds">;

export const TOKEN_PREFIX = {
  pat: "om_pat_",
  access: "om_mcp_at_",
  refresh: "om_mcp_rt_",
  code: "om_mcp_ac_",
} as const;

/** 256 bits of randomness behind a recognizable prefix. */
export const newToken = (prefix: string) => `${prefix}${randomBytes(32).toString("base64url")}`;

/**
 * Token hashes use their own key: MCP_TOKEN_SECRET, or one derived from SESSION_SECRET with a fixed label, so an
 * MCP token hash can never be confused with (or computed from) a session token hash.
 */
const keyCache = new WeakMap<AppConfig, Buffer>();
function tokenKey(config: AppConfig) {
  let k = keyCache.get(config);
  if (!k) {
    k = config.MCP_TOKEN_SECRET
      ? Buffer.from(config.MCP_TOKEN_SECRET)
      : createHmac("sha256", config.SESSION_SECRET).update("openmanga mcp token key v1").digest();
    keyCache.set(config, k);
  }
  return k;
}
export const hashMcpToken = (config: AppConfig, token: string) =>
  createHmac("sha256", tokenKey(config)).update(token).digest("hex");

/** The public identities of the MCP resource and its authorization server. */
export function mcpUrls(config: AppConfig) {
  const origin = new URL(config.API_PUBLIC_URL).origin;
  const resource = (config.MCP_PUBLIC_URL ?? `${origin}/mcp`).replace(/\/$/, "");
  const issuer = (config.MCP_AUTH_ISSUER ?? origin).replace(/\/$/, "");
  return {
    resource,
    issuer,
    /** RFC 9728 path-inserted metadata URL for this resource (what the 401 challenge points at). */
    resourceMetadata: getOAuthProtectedResourceMetadataUrl(new URL(resource)),
    authorize: `${issuer}/oauth/authorize`,
    token: `${issuer}/oauth/token`,
    register: `${issuer}/oauth/register`,
    revoke: `${issuer}/oauth/revoke`,
    docs: `${config.APP_PUBLIC_URL.replace(/\/$/, "")}/agents`,
  };
}

/** The hosts `/mcp` answers on: the public URLs' hosts, configured extras, and localhost for development. */
export function mcpAllowedHosts(config: AppConfig) {
  const u = mcpUrls(config);
  const hosts = new Set<string>([
    new URL(u.resource).hostname,
    new URL(u.issuer).hostname,
    new URL(config.API_PUBLIC_URL).hostname,
    new URL(config.APP_PUBLIC_URL).hostname,
    "localhost",
    "127.0.0.1",
    "[::1]",
  ]);
  for (const h of config.MCP_ALLOWED_HOSTS.split(",")) if (h.trim()) hosts.add(h.trim().toLowerCase());
  return [...hosts];
}

/**
 * Loads a connection as an actor, or null when it can no longer act: revoked, its user gone or disabled.
 * `tokenScopes` narrows further when the credential carries its own snapshot (an OAuth token); the connection's
 * current scopes always win when they have been reduced since.
 */
export async function loadActor(db: Database, serviceId: string, tokenScopes?: string[]): Promise<McpActor | null> {
  const [row] = await db
    .select({ s: userServices, u: users })
    .from(userServices)
    .innerJoin(users, eq(users.id, userServices.userId))
    .where(and(eq(userServices.id, serviceId), isNull(userServices.revokedAt)));
  if (row?.u.status !== "active") return null;
  const granted = normalizeScopes(row.s.scopes);
  const scopes = tokenScopes ? granted.filter((s) => tokenScopes.includes(s)) : granted;
  const projectIds =
    row.s.projectAccess === "selected"
      ? new Set(
          (
            await db
              .select({ id: userServiceProjects.projectId })
              .from(userServiceProjects)
              .where(eq(userServiceProjects.serviceId, serviceId))
          ).map((p) => p.id),
        )
      : new Set<string>();
  const u = row.u;
  return {
    user: {
      id: u.id,
      username: u.username,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      status: u.status,
      settings: u.settings,
    },
    serviceId: row.s.id,
    serviceName: row.s.name,
    serviceKind: row.s.kind,
    clientId: row.s.clientId,
    scopes: new Set(scopes),
    projectAccess: row.s.projectAccess,
    projectIds,
    allowProjectCreate: row.s.allowProjectCreate,
    approvalMode: row.s.approvalMode,
  };
}

/** Whether a connection may touch a project at all (membership is checked separately, and both must pass). */
export const serviceMayAccess = (r: ServiceRestriction, projectId: string) =>
  r.projectAccess === "all" || r.projectIds.has(projectId);
