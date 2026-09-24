import type { UserSettings } from "@openmanga/schemas";
import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, id, ts, updatedAt, userRole, userStatus } from "./common.ts";

export const users = pgTable(
  "users",
  {
    id: id(),
    username: text("username").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("user"),
    /** Per-account preferences that seed new projects; see UserSettings in @openmanga/schemas. */
    settings: jsonb("settings").$type<UserSettings>().notNull().default({}),
    status: userStatus("status").notNull().default("active"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("users_username_uq").on(t.username), uniqueIndex("users_email_uq").on(t.email)],
);

export const authIdentities = pgTable(
  "auth_identities",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("auth_identities_provider_subject_uq").on(t.provider, t.providerSubject),
    index("auth_identities_user_idx").on(t.userId),
  ],
);

export const passwordCredentials = pgTable("password_credentials", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  passwordHash: text("password_hash").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable(
  "sessions",
  {
    id: id(),
    tokenHash: text("token_hash").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("sessions_token_hash_uq").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("password_reset_tokens_hash_uq").on(t.tokenHash)],
);

export const devEmails = pgTable("dev_emails", {
  id: id(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  textBody: text("text_body").notNull(),
  htmlBody: text("html_body"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  read: boolean("read").notNull().default(false),
  createdAt: createdAt(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    userId: uuid("user_id"),
    projectId: uuid("project_id"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ip: text("ip"),
    requestId: text("request_id"),
    /** The connected agent (user_service) that did this on the user's behalf, if any. */
    serviceId: uuid("service_id"),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_events_project_idx").on(t.projectId, t.createdAt),
    index("audit_events_created_idx").on(t.createdAt),
  ],
);

/**
 * Bring-your-own-key provider credentials. The key is AES-256-GCM encrypted by the services layer
 * (never stored or logged in plaintext); only keyHint (last 4 chars) is ever returned to clients.
 */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    baseUrl: text("base_url"),
    encryptedKey: text("encrypted_key").notNull(),
    keyHint: text("key_hint").notNull(),
    lastUsedAt: ts("last_used_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("provider_credentials_user_idx").on(t.userId)],
);
