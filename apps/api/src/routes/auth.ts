import { AuthError, RegisterInput } from "@openmanga/auth";
import { and, desc, devEmails, eq, isNull, sessions, users } from "@openmanga/db";
import { UserSettings } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiError, body, clientIp, notFound, requireUser, user, uuidParam } from "../lib/http.ts";
import { checkLoginThrottle, clearSessionCookie, rateLimit, setSessionCookie } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

const LoginInput = z.object({ identifier: z.string().trim().min(1).max(254), password: z.string().min(1).max(256) });
const ResetRequest = z.object({ identifier: z.string().trim().min(1).max(254) });
const ResetConfirm = z.object({ token: z.string().min(10).max(128), password: z.string().min(1).max(256) });
const ChangePassword = z.object({ currentPassword: z.string().min(1), newPassword: z.string().min(1) });

export const authRoutes = new Hono<AppEnv>();
const authLimit = rateLimit({ key: "auth", limit: () => 30, windowSec: 60 });
/** Change-password verifies the current one, so it is a guessing oracle for whoever holds the session. */
const passwordLimit = rateLimit({ key: "password", limit: () => 10, windowSec: 60, by: "user" });

doc({ method: "GET", path: "/api/auth/config", summary: "Public auth configuration", tag: "auth", auth: false });
authRoutes.get("/config", (c) => {
  const cfg = c.get("deps").config;
  return c.json({ registrationEnabled: cfg.REGISTRATION_ENABLED, devMailboxEnabled: cfg.devMailboxEnabled });
});

doc({
  method: "POST",
  path: "/api/auth/register",
  summary: "Register with username, email and password",
  tag: "auth",
  body: RegisterInput,
  auth: false,
});
authRoutes.post("/register", authLimit, async (c) => {
  const deps = c.get("deps");
  if (!deps.config.REGISTRATION_ENABLED)
    throw new AuthError("registration_disabled", "Registration is disabled. Ask an administrator for an account.");
  const input = await body(c, RegisterInput);
  const u = await deps.auth.createUser(input);
  const s = await deps.auth.createSession(u.id, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
  setSessionCookie(c, s.token, s.expiresAt);
  await recordAudit(deps.db, { userId: u.id, action: "auth.register", ip: clientIp(c), requestId: c.get("requestId") });
  return c.json({ user: u }, 201);
});

doc({
  method: "POST",
  path: "/api/auth/login",
  summary: "Login with username or email + password",
  tag: "auth",
  body: LoginInput,
  auth: false,
});
authRoutes.post("/login", authLimit, async (c) => {
  const deps = c.get("deps");
  const { identifier, password } = await body(c, LoginInput);
  const ip = clientIp(c);
  const throttle = await checkLoginThrottle(deps, identifier, ip);
  let u: Awaited<ReturnType<typeof deps.auth.verifyCredentials>>;
  try {
    u = await deps.auth.verifyCredentials(identifier, password);
  } catch (e) {
    await throttle.fail();
    await recordAudit(deps.db, {
      action: "auth.login_failed",
      metadata: { identifier: identifier.slice(0, 64) },
      ip,
      requestId: c.get("requestId"),
    });
    throw e;
  }
  await throttle.success();
  const s = await deps.auth.rotateSession(c.get("sessionId"), u.id, { ip, userAgent: c.req.header("user-agent") });
  setSessionCookie(c, s.token, s.expiresAt);
  await recordAudit(deps.db, { userId: u.id, action: "auth.login", ip, requestId: c.get("requestId") });
  return c.json({ user: u });
});

doc({ method: "POST", path: "/api/auth/logout", summary: "Logout current session", tag: "auth" });
authRoutes.post("/logout", async (c) => {
  const sid = c.get("sessionId");
  if (sid) await c.get("deps").auth.revokeSession(sid);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

doc({ method: "POST", path: "/api/auth/logout-all", summary: "Revoke all sessions for current user", tag: "auth" });
authRoutes.post("/logout-all", requireUser, async (c) => {
  const u = user(c);
  const n = await c.get("deps").auth.revokeAllSessions(u.id);
  clearSessionCookie(c);
  await recordAudit(c.get("deps").db, {
    userId: u.id,
    action: "auth.logout_all",
    metadata: { revoked: n },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true, revoked: n });
});

doc({ method: "GET", path: "/api/auth/me", summary: "Current user", tag: "auth" });
authRoutes.get("/me", (c) => c.json({ user: c.get("user") }));

const PatchSettings = z.object({
  /** Empty string clears the preference, so new projects fall back to the server default again. */
  narrationVoice: z.string().trim().max(64).optional(),
});
doc({
  method: "PATCH",
  path: "/api/auth/settings",
  summary: "Account preferences that seed new projects (narration voice)",
  tag: "auth",
  body: PatchSettings,
});
authRoutes.patch("/settings", requireUser, async (c) => {
  const u = user(c);
  const input = await body(c, PatchSettings);
  const { db } = c.get("deps");
  // Merged rather than replaced, and an empty value deletes the key instead of storing "" as a voice id.
  const next: Record<string, unknown> = { ...u.settings };
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (v === "") delete next[k];
    else next[k] = v;
  }
  const settings = UserSettings.parse(next);
  const [row] = await db.update(users).set({ settings }).where(eq(users.id, u.id)).returning();
  return c.json({ settings: row!.settings });
});

doc({ method: "GET", path: "/api/auth/sessions", summary: "List active sessions", tag: "auth" });
authRoutes.get("/sessions", requireUser, async (c) => {
  const u = user(c);
  const rows = await c
    .get("deps")
    .db.select({
      id: sessions.id,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
      expiresAt: sessions.expiresAt,
      ip: sessions.ip,
      userAgent: sessions.userAgent,
    })
    .from(sessions)
    .where(and(eq(sessions.userId, u.id), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.lastUsedAt));
  return c.json({ sessions: rows.map((r) => ({ ...r, current: r.id === c.get("sessionId") })) });
});

doc({
  method: "POST",
  path: "/api/auth/password",
  summary: "Change password (rotates session, revokes others)",
  tag: "auth",
  body: ChangePassword,
});
authRoutes.post("/password", requireUser, passwordLimit, async (c) => {
  const deps = c.get("deps");
  const u = user(c);
  const input = await body(c, ChangePassword);
  await deps.auth.changePassword(u.id, input.currentPassword, input.newPassword);
  await deps.auth.revokeAllSessions(u.id);
  const s = await deps.auth.createSession(u.id, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
  setSessionCookie(c, s.token, s.expiresAt);
  await recordAudit(deps.db, { userId: u.id, action: "auth.password_changed", requestId: c.get("requestId") });
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/auth/password-reset/request",
  summary: "Request a password reset email (always 200)",
  tag: "auth",
  body: ResetRequest,
  auth: false,
});
authRoutes.post("/password-reset/request", authLimit, async (c) => {
  const deps = c.get("deps");
  const { identifier } = await body(c, ResetRequest);
  const r = await deps.auth.createPasswordReset(identifier);
  if (r) {
    const url = deps.urls.passwordResetUrl(r.token);
    await deps.mail.send({
      to: r.user.email,
      subject: "Reset your OpenManga password",
      text: `Hi ${r.user.username},\n\nUse this link within 1 hour to reset your password:\n${url}\n\nIf you did not request this, ignore this email.`,
      html: `<p>Hi ${r.user.username},</p><p><a href="${url}">Reset your password</a> (valid for 1 hour).</p><p>If you did not request this, ignore this email.</p>`,
      metadata: { kind: "password_reset", resetUrl: url, userId: r.user.id },
    });
    await recordAudit(deps.db, {
      userId: r.user.id,
      action: "auth.password_reset_requested",
      ip: clientIp(c),
      requestId: c.get("requestId"),
    });
  }
  return c.json({ ok: true, message: "If an account exists, a reset link has been sent." });
});

doc({
  method: "POST",
  path: "/api/auth/password-reset/confirm",
  summary: "Reset password with one-time token",
  tag: "auth",
  body: ResetConfirm,
  auth: false,
});
authRoutes.post("/password-reset/confirm", authLimit, async (c) => {
  const deps = c.get("deps");
  const { token, password } = await body(c, ResetConfirm);
  const userId = await deps.auth.resetPassword(token, password);
  await recordAudit(deps.db, { userId, action: "auth.password_reset", ip: clientIp(c), requestId: c.get("requestId") });
  return c.json({ ok: true });
});

// ---- Dev mailbox (NODE_ENV != production, or DEV_MAILBOX_ENABLED=true)
export const devMailRoutes = new Hono<AppEnv>();
devMailRoutes.use("*", async (c, next) => {
  const cfg = c.get("deps").config;
  if (!cfg.devMailboxEnabled) throw notFound();
  // Every mail in here carries a password-reset link, so it is admin-only in every environment: making this
  // depend on NODE_ENV means one misconfigured deployment publishes account takeover to anonymous callers.
  if (c.get("user")?.role !== "admin")
    throw new ApiError(403, "forbidden", "The dev mailbox is restricted to administrators.");
  await next();
});
doc({ method: "GET", path: "/api/dev/mailbox", summary: "Dev mailbox: list emails", tag: "dev" });
devMailRoutes.get("/mailbox", async (c) => {
  const rows = await c.get("deps").db.select().from(devEmails).orderBy(desc(devEmails.createdAt)).limit(100);
  return c.json({ emails: rows });
});
doc({ method: "GET", path: "/api/dev/mailbox/:id", summary: "Dev mailbox: read email", tag: "dev" });
devMailRoutes.get("/mailbox/:id", async (c) => {
  const id = uuidParam(c, "id");
  const db = c.get("deps").db;
  const [row] = await db.select().from(devEmails).where(eq(devEmails.id, id));
  if (!row) throw notFound("Email");
  await db.update(devEmails).set({ read: true }).where(eq(devEmails.id, id));
  return c.json({ email: row });
});
doc({ method: "DELETE", path: "/api/dev/mailbox", summary: "Dev mailbox: clear", tag: "dev" });
devMailRoutes.delete("/mailbox", async (c) => {
  await c.get("deps").db.delete(devEmails);
  return c.json({ ok: true });
});
