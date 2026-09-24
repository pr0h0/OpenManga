import { boolean, index, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { projects } from "./projects.ts";

export type McpApprovalMode = "ALLOW_ALL" | "REQUIRE_APPROVAL";
export type McpProjectAccess = "all" | "selected";

/**
 * A connected agent: a "user_service". It belongs to one user and acts as that user, limited by its own scopes,
 * project access and approval mode. OAuth grants (ChatGPT) and personal access tokens both resolve to one of these,
 * so everything downstream (scopes, projects, approvals, audit) has one model.
 */
export const userServices = pgTable(
  "user_services",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"oauth" | "pat">().notNull(),
    name: text("name").notNull(),
    /** The OAuth client this connection was granted to (null for a personal access token). */
    clientId: text("client_id"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    projectAccess: text("project_access").$type<McpProjectAccess>().notNull().default("selected"),
    allowProjectCreate: boolean("allow_project_create").notNull().default(false),
    approvalMode: text("approval_mode").$type<McpApprovalMode>().notNull().default("REQUIRE_APPROVAL"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("user_services_user_idx").on(t.userId, t.createdAt)],
);

/** The projects a `selected`-access connection may touch. */
export const userServiceProjects = pgTable(
  "user_service_projects",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.projectId] })],
);

/** A personal access token (`om_pat_…`): only its HMAC is stored, and it is shown once. */
export const personalAccessTokens = pgTable(
  "personal_access_tokens",
  {
    id: id(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** The last characters of the token, so the UI can tell tokens apart without storing them. */
    hint: text("hint").notNull(),
    expiresAt: ts("expires_at"),
    lastUsedAt: ts("last_used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("personal_access_tokens_hash_uq").on(t.tokenHash)],
);

/**
 * An OAuth client: registered dynamically (DCR, `oc_…` ids) or described by a Client ID Metadata Document (CIMD,
 * the client id is the document's https URL). Only public clients: no secrets are issued.
 */
export const oauthClients = pgTable("oauth_clients", {
  id: text("id").primaryKey(),
  kind: text("kind").$type<"dcr" | "cimd">().notNull(),
  name: text("name").notNull(),
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  /** CIMD only: when the document was last fetched, so it is refreshed rather than trusted forever. */
  fetchedAt: ts("fetched_at"),
  createdAt: createdAt(),
});

/**
 * An authorization request, frozen when it arrives. The consent page only ever refers to it by id, so nothing the
 * browser sends during consent can change the client, redirect, PKCE challenge, resource or state.
 */
export const oauthAuthorizationRequests = pgTable("oauth_authorization_requests", {
  id: id(),
  clientId: text("client_id").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  state: text("state"),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  expiresAt: ts("expires_at").notNull(),
  completedAt: ts("completed_at"),
  createdAt: createdAt(),
});

export const oauthAuthorizationCodes = pgTable("oauth_authorization_codes", {
  codeHash: text("code_hash").primaryKey(),
  clientId: text("client_id").notNull(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => userServices.id, { onDelete: "cascade" }),
  redirectUri: text("redirect_uri").notNull(),
  codeChallenge: text("code_challenge").notNull(),
  resource: text("resource").notNull(),
  scopes: jsonb("scopes").$type<string[]>().notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    /** The refresh-token family (one per authorization) this token was issued in, so a compromise revokes it too. */
    familyId: uuid("family_id").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_access_tokens_family_idx").on(t.familyId)],
);

/** Rotating refresh tokens: each use consumes one and issues the next in the same family. */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: uuid("family_id").notNull(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    clientId: text("client_id").notNull(),
    resource: text("resource").notNull(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: ts("expires_at").notNull(),
    /** Set when rotated: presenting it again means it leaked. */
    usedAt: ts("used_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [index("oauth_refresh_tokens_family_idx").on(t.familyId)],
);

export type McpApprovalStatus = "pending" | "approved" | "denied" | "expired" | "stale" | "executed" | "failed";

/** A sensitive call parked for the user's decision, executed once if approved. */
export const mcpApprovalRequests = pgTable(
  "mcp_approval_requests",
  {
    id: id(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    toolName: text("tool_name").notNull(),
    actionKey: text("action_key").notNull(),
    sensitivity: text("sensitivity").notNull(),
    summary: text("summary").notNull(),
    arguments: jsonb("arguments").$type<Record<string, unknown>>().notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    idempotencyKey: text("idempotency_key"),
    /** The targets' state when the request was made; approval refuses to run against a target that has changed. */
    targetSnapshot: jsonb("target_snapshot").$type<Record<string, unknown>>(),
    estimate: jsonb("estimate").$type<Record<string, unknown>>(),
    status: text("status").$type<McpApprovalStatus>().notNull().default("pending"),
    decisionReason: text("decision_reason"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: jsonb("error").$type<Record<string, unknown>>(),
    expiresAt: ts("expires_at").notNull(),
    decidedAt: ts("decided_at"),
    executedAt: ts("executed_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("mcp_approval_requests_user_idx").on(t.userId, t.status, t.createdAt),
    index("mcp_approval_requests_service_idx").on(t.serviceId, t.argumentsHash),
  ],
);

/** "Remember for this project": one connection, one project, one action, allowed or denied without asking. */
export const mcpApprovalRules = pgTable(
  "mcp_approval_rules",
  {
    id: id(),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    actionKey: text("action_key").notNull(),
    decision: text("decision").$type<"ALLOW" | "DENY">().notNull(),
    sourceRequestId: uuid("source_request_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("mcp_approval_rules_uq").on(t.serviceId, t.projectId, t.actionKey)],
);

/** A call's result under a caller-supplied idempotency key, so a retried call never repeats its side effect. */
export const mcpIdempotency = pgTable(
  "mcp_idempotency",
  {
    serviceId: uuid("service_id")
      .notNull()
      .references(() => userServices.id, { onDelete: "cascade" }),
    toolName: text("tool_name").notNull(),
    key: text("key").notNull(),
    argumentsHash: text("arguments_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.serviceId, t.toolName, t.key] })],
);
