import { AuthError, hashToken, newOpaqueToken, RegisterInput } from "@openmanga/auth";
import {
  type AnyColumn,
  and,
  asc,
  type DbOrTx,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  projectInvites,
  projectMembers,
  projects,
  type SQL,
  sql,
  userServiceProjects,
  userServices,
  users,
  youtubeLinks,
} from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, body, clientIp, conflict, notFound, requireUser, user, uuidParam } from "../lib/http.ts";
import { failureGuard, rateLimit, setSessionCookie } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

/** How long an invitation stays open. */
const INVITE_TTL_MS = 7 * 86400_000;
const InviteRole = z.enum(["editor", "viewer"]);

/** Invitations send mail, so they are capped per inviting account. */
const inviteLimit = rateLimit({ key: "invite", limit: () => 30, windowSec: 3600, by: "user" });
const authLimit = rateLimit({ key: "auth", limit: () => 30, windowSec: 60 });
const registerLimit = rateLimit({ key: "register", limit: () => 10, windowSec: 3600 });

/** Not accepted, declined, revoked or expired. */
const pending = () =>
  and(
    isNull(projectInvites.acceptedAt),
    isNull(projectInvites.declinedAt),
    isNull(projectInvites.revokedAt),
    gt(projectInvites.expiresAt, new Date()),
  );

/** A user's username by id, inline (no table alias needed for a second join on users). */
const usernameOf = (col: AnyColumn) => sql<string | null>`(select u.username from users u where u.id = ${col})`;

const tokenHash = (c: Context<AppEnv>, token: string) => hashToken(token, c.get("deps").config.SESSION_SECRET);

async function publishMembers(c: Context<AppEnv>, projectId: string, removedUserId?: string) {
  await c
    .get("deps")
    .events.publish(projectId, { type: "members.updated", ...(removedUserId ? { removedUserId } : {}) })
    .catch(() => {});
}

/** Adds the member (keeping a role they already hold) once an invite is claimed. */
async function join(db: DbOrTx, invite: { projectId: string; role: "owner" | "editor" | "viewer" }, userId: string) {
  await db
    .insert(projectMembers)
    .values({ projectId: invite.projectId, userId, role: invite.role })
    .onConflictDoNothing();
}

export const memberRoutes = new Hono<AppEnv>();

doc({
  method: "GET",
  path: "/api/projects/:projectId/members",
  summary: "The project's members; owners also get the pending invitations",
  tag: "members",
});
memberRoutes.get("/projects/:projectId/members", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const members = await db
    .select({
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      role: projectMembers.role,
      createdAt: projectMembers.createdAt,
    })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, p.id))
    .orderBy(asc(projectMembers.createdAt));
  const canManage = await projectAccess(c, p.id, "manage").then(
    () => true,
    () => false,
  );
  const invites = canManage
    ? await db
        .select({
          id: projectInvites.id,
          role: projectInvites.role,
          email: projectInvites.email,
          username: usernameOf(projectInvites.userId),
          invitedBy: usernameOf(projectInvites.invitedByUserId),
          expiresAt: projectInvites.expiresAt,
          createdAt: projectInvites.createdAt,
        })
        .from(projectInvites)
        .where(and(eq(projectInvites.projectId, p.id), pending()))
        .orderBy(desc(projectInvites.createdAt))
    : [];
  return c.json({
    members,
    // An invite by email shows the address, never the account behind it: which addresses have accounts is not
    // something an inviter learns.
    invites: invites.map((i) => ({ ...i, username: i.email ? null : i.username })),
    canManage,
  });
});

const CreateInvite = z.object({
  /** A username, or an email address (anything with an @). */
  identifier: z.string().trim().toLowerCase().min(1).max(254),
  role: InviteRole,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/invites",
  summary:
    "Invite someone as editor or viewer (owners only). A username invites that account in the app; an email address is sent a one-time link that accepts, or creates the account for that address even when registration is closed.",
  tag: "members",
  body: CreateInvite,
});
memberRoutes.post("/projects/:projectId/invites", inviteLimit, async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const { identifier, role } = await body(c, CreateInvite);
  const deps = c.get("deps");
  const me = user(c);
  const byEmail = identifier.includes("@");
  if (byEmail && !z.string().email().safeParse(identifier).success)
    throw badRequest("That is not a valid email address");
  const [account] = await deps.db
    .select({ id: users.id })
    .from(users)
    .where(byEmail ? eq(users.email, identifier) : eq(users.username, identifier));
  if (!byEmail && !account) throw notFound("Account with that username");
  if (account?.id === me.id) throw badRequest("You are already in this project");
  if (account) {
    const [member] = await deps.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, account.id)));
    if (member) throw conflict("They are already a member of this project");
  }
  const token = byEmail ? newOpaqueToken() : null;
  const invite = await deps.db.transaction(async (tx) => {
    // Inviting again replaces the open invitation (a new role, a fresh link) rather than stacking them.
    await tx
      .update(projectInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(projectInvites.projectId, p.id),
          pending(),
          byEmail ? eq(projectInvites.email, identifier) : eq(projectInvites.userId, account!.id),
        ),
      );
    const [row] = await tx
      .insert(projectInvites)
      .values({
        projectId: p.id,
        role,
        userId: account?.id ?? null,
        email: byEmail ? identifier : null,
        tokenHash: token ? tokenHash(c, token) : null,
        invitedByUserId: me.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      })
      .returning();
    return row!;
  });
  if (token) {
    const url = deps.urls.inviteUrl(token);
    // Plain text only: the project title is the inviter's words, and none of it is meant to render as markup.
    await deps.mail.send({
      to: identifier,
      subject: `${me.displayName || me.username} invited you to a project on OpenManga`,
      text: `${me.displayName || me.username} invited you to "${p.title}" on OpenManga as ${role === "editor" ? "an editor" : "a viewer"}.\n\nOpen this link within 7 days to accept. If you have no account yet, it lets you create one for this address:\n${url}\n\nIf you were not expecting this, ignore this email.`,
      metadata: { kind: "project_invite", inviteUrl: url, projectId: p.id, inviteId: invite.id },
    });
  }
  await recordAudit(deps.db, {
    userId: me.id,
    projectId: p.id,
    action: "member.invite",
    targetType: "invite",
    targetId: invite.id,
    metadata: { role, by: byEmail ? "email" : "username" },
    requestId: c.get("requestId"),
  });
  await publishMembers(c, p.id);
  return c.json(
    {
      invite: {
        id: invite.id,
        role: invite.role,
        email: invite.email,
        username: byEmail ? null : identifier,
        expiresAt: invite.expiresAt,
      },
    },
    201,
  );
});

doc({
  method: "DELETE",
  path: "/api/invites/:id",
  summary: "Revoke a pending invitation (owners only)",
  tag: "members",
});
memberRoutes.delete("/invites/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [invite] = await db.select().from(projectInvites).where(eq(projectInvites.id, id));
  if (!invite) throw notFound("Invitation");
  await projectAccess(c, invite.projectId, "manage");
  const [row] = await db
    .update(projectInvites)
    .set({ revokedAt: new Date() })
    .where(and(eq(projectInvites.id, id), pending()))
    .returning({ id: projectInvites.id });
  if (!row) throw conflict("This invitation is no longer pending");
  await recordAudit(db, {
    userId: user(c).id,
    projectId: invite.projectId,
    action: "member.invite_revoke",
    targetType: "invite",
    targetId: id,
    requestId: c.get("requestId"),
  });
  await publishMembers(c, invite.projectId);
  return c.json({ ok: true });
});

const ChangeRole = z.object({ role: InviteRole });
doc({
  method: "PATCH",
  path: "/api/projects/:projectId/members/:userId",
  summary: "Change a member's role to editor or viewer (owners only)",
  tag: "members",
  body: ChangeRole,
});
memberRoutes.patch("/projects/:projectId/members/:userId", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const target = uuidParam(c, "userId");
  const { role } = await body(c, ChangeRole);
  if (target === p.ownerUserId) throw badRequest("The owner's role can't be changed");
  const { db } = c.get("deps");
  const [before] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, target)));
  if (!before) throw notFound("Member");
  await db
    .update(projectMembers)
    .set({ role })
    .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, target)));
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "member.role_change",
    targetType: "user",
    targetId: target,
    metadata: { from: before.role, to: role },
    requestId: c.get("requestId"),
  });
  await publishMembers(c, p.id);
  return c.json({ ok: true, role });
});

doc({
  method: "DELETE",
  path: "/api/projects/:projectId/members/:userId",
  summary: "Remove a member (owners only), or leave a project yourself (your own user id)",
  tag: "members",
});
memberRoutes.delete("/projects/:projectId/members/:userId", async (c) => {
  const target = uuidParam(c, "userId");
  const me = user(c);
  const leaving = target === me.id;
  const p = await projectAccess(c, uuidParam(c, "projectId"), leaving ? "read" : "manage");
  if (target === p.ownerUserId)
    throw badRequest(leaving ? "The owner can't leave their own project" : "The owner can't be removed");
  const { db } = c.get("deps");
  const [row] = await db
    .delete(projectMembers)
    .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, target)))
    .returning({ role: projectMembers.role });
  if (!row) throw notFound("Member");
  // Their agent connections lose the project too, so rejoining later does not silently restore an old grant.
  const theirs = db.select({ id: userServices.id }).from(userServices).where(eq(userServices.userId, target));
  await db
    .delete(userServiceProjects)
    .where(and(eq(userServiceProjects.projectId, p.id), inArray(userServiceProjects.serviceId, theirs)));
  // Videos they linked from their own channels stop drawing on their grant here: the project keeps the links, with
  // public counters only, and the channel's analytics and reach stay theirs.
  await db
    .update(youtubeLinks)
    .set({ connectionId: null })
    .where(and(eq(youtubeLinks.projectId, p.id), eq(youtubeLinks.createdBy, target)));
  await recordAudit(db, {
    userId: me.id,
    projectId: p.id,
    action: leaving ? "member.leave" : "member.remove",
    targetType: "user",
    targetId: target,
    metadata: { role: row.role },
    requestId: c.get("requestId"),
  });
  await publishMembers(c, p.id, target);
  return c.json({ ok: true });
});

// ---- The invited person's side.

doc({ method: "GET", path: "/api/invites", summary: "Your pending project invitations", tag: "members" });
memberRoutes.get("/invites", async (c) => {
  const me = user(c);
  const rows = await c
    .get("deps")
    .db.select({
      id: projectInvites.id,
      role: projectInvites.role,
      projectId: projects.id,
      projectTitle: projects.title,
      invitedBy: usernameOf(projectInvites.invitedByUserId),
      expiresAt: projectInvites.expiresAt,
      createdAt: projectInvites.createdAt,
    })
    .from(projectInvites)
    .innerJoin(projects, eq(projects.id, projectInvites.projectId))
    .where(and(eq(projectInvites.userId, me.id), pending(), isNull(projects.deletedAt)))
    .orderBy(desc(projectInvites.createdAt));
  return c.json({ invites: rows });
});

/** Claims one pending invitation (atomically, so it is used once) and joins its project. */
async function accept(c: Context<AppEnv>, where: SQL | undefined, userId: string) {
  const { db } = c.get("deps");
  const invite = await db.transaction(async (tx) => {
    const [row] = await tx
      .update(projectInvites)
      .set({ acceptedAt: new Date(), userId })
      .where(and(where, pending()))
      .returning();
    if (row) await join(tx, row, userId);
    return row;
  });
  if (!invite) return null;
  await recordAudit(db, {
    userId,
    projectId: invite.projectId,
    action: "member.accept",
    targetType: "invite",
    targetId: invite.id,
    metadata: { role: invite.role },
    requestId: c.get("requestId"),
  });
  await publishMembers(c, invite.projectId);
  return invite;
}

doc({ method: "POST", path: "/api/invites/:id/accept", summary: "Accept an invitation to a project", tag: "members" });
memberRoutes.post("/invites/:id/accept", async (c) => {
  const me = user(c);
  const invite = await accept(
    c,
    and(eq(projectInvites.id, uuidParam(c, "id")), eq(projectInvites.userId, me.id)),
    me.id,
  );
  if (!invite) throw notFound("Invitation");
  return c.json({ projectId: invite.projectId, role: invite.role });
});

doc({
  method: "POST",
  path: "/api/invites/:id/decline",
  summary: "Decline an invitation to a project",
  tag: "members",
});
memberRoutes.post("/invites/:id/decline", async (c) => {
  const me = user(c);
  const { db } = c.get("deps");
  const [invite] = await db
    .update(projectInvites)
    .set({ declinedAt: new Date() })
    .where(and(eq(projectInvites.id, uuidParam(c, "id")), eq(projectInvites.userId, me.id), pending()))
    .returning();
  if (!invite) throw notFound("Invitation");
  await recordAudit(db, {
    userId: me.id,
    projectId: invite.projectId,
    action: "member.decline",
    targetType: "invite",
    targetId: invite.id,
    requestId: c.get("requestId"),
  });
  await publishMembers(c, invite.projectId);
  return c.json({ ok: true });
});

const TokenInput = z.object({ token: z.string().min(10).max(128) });
/** An invite link is a secret: wrong ones are capped per address like a password-reset token. */
const tokenGuard = (c: Context<AppEnv>) => failureGuard(c, "invite-token", 10, 3600);
const invalidLink = () => new AuthError("invalid_token", "This invitation link is invalid, used or expired");

doc({
  method: "POST",
  path: "/api/invites/accept-link",
  summary: "Accept an emailed invitation link while signed in to the account of that address",
  tag: "members",
  body: TokenInput,
});
memberRoutes.post("/invites/accept-link", requireUser, async (c) => {
  const me = user(c);
  const { token } = await body(c, TokenInput);
  const guesses = await tokenGuard(c);
  const hash = tokenHash(c, token);
  const [found] = await c
    .get("deps")
    .db.select({ email: projectInvites.email, userId: projectInvites.userId })
    .from(projectInvites)
    .where(and(eq(projectInvites.tokenHash, hash), pending()));
  if (!found) {
    await guesses.fail();
    throw invalidLink();
  }
  // The link stands for its address: it joins only the account that owns that address.
  if (found.email !== me.email && found.userId !== me.id)
    throw new ApiError(
      403,
      "invite_other_account",
      "This invitation was sent to a different email address. Sign in with that account to accept it.",
    );
  const invite = await accept(c, eq(projectInvites.tokenHash, hash), me.id);
  if (!invite) throw invalidLink();
  return c.json({ projectId: invite.projectId, role: invite.role });
});

const InviteSignup = TokenInput.extend({
  username: RegisterInput.shape.username,
  password: RegisterInput.shape.password,
  displayName: RegisterInput.shape.displayName,
});
doc({
  method: "POST",
  path: "/api/auth/invite-signup",
  summary:
    "Create an account from an emailed invitation link and join its project. Works while registration is closed, once, for the invited address only.",
  tag: "auth",
  body: InviteSignup,
  auth: false,
});
memberRoutes.post("/auth/invite-signup", authLimit, registerLimit, async (c) => {
  const deps = c.get("deps");
  const input = await body(c, InviteSignup);
  const guesses = await tokenGuard(c);
  const hash = tokenHash(c, input.token);
  // Claiming the invitation and creating the account are one transaction: a taken username rolls the claim back,
  // and two submissions of the same link cannot both create an account.
  const result = await deps.db
    .transaction(async (tx) => {
      const [invite] = await tx
        .update(projectInvites)
        .set({ acceptedAt: new Date() })
        .where(and(eq(projectInvites.tokenHash, hash), pending()))
        .returning();
      if (!invite?.email) throw invalidLink();
      const u = await deps.auth.createUser(
        { username: input.username, email: invite.email, password: input.password, displayName: input.displayName },
        "user",
        tx,
      );
      await tx.update(projectInvites).set({ userId: u.id }).where(eq(projectInvites.id, invite.id));
      await join(tx, invite, u.id);
      return { u, invite };
    })
    .catch(async (e) => {
      if (e instanceof AuthError && e.code === "invalid_token") await guesses.fail();
      if (e instanceof AuthError && e.code === "conflict")
        throw new AuthError(
          "conflict",
          "That username is taken, or this address already has an account. Sign in to accept the invitation instead.",
        );
      throw e;
    });
  const { u, invite } = result;
  const s = await deps.auth.createSession(u.id, { ip: clientIp(c), userAgent: c.req.header("user-agent") });
  setSessionCookie(c, s.token, s.expiresAt);
  await recordAudit(deps.db, {
    userId: u.id,
    action: "auth.register",
    metadata: { via: "invite" },
    ip: clientIp(c),
    requestId: c.get("requestId"),
  });
  await recordAudit(deps.db, {
    userId: u.id,
    projectId: invite.projectId,
    action: "member.accept",
    targetType: "invite",
    targetId: invite.id,
    metadata: { role: invite.role },
    requestId: c.get("requestId"),
  });
  await publishMembers(c, invite.projectId);
  return c.json({ user: u, projectId: invite.projectId }, 201);
});

/** What an invitation link opens, before signing in: enough to decide, nothing more. */
export const publicInviteRoutes = new Hono<AppEnv>();
doc({
  method: "GET",
  path: "/api/public/invites/:token",
  summary:
    "What an emailed invitation link is for: project title, role, inviter, and whether the address has an account",
  tag: "members",
  auth: false,
});
publicInviteRoutes.get("/invites/:token", async (c) => {
  const guesses = await tokenGuard(c);
  const { db } = c.get("deps");
  const [row] = await db
    .select({
      email: projectInvites.email,
      role: projectInvites.role,
      expiresAt: projectInvites.expiresAt,
      projectTitle: projects.title,
      invitedBy: usernameOf(projectInvites.invitedByUserId),
    })
    .from(projectInvites)
    .innerJoin(projects, eq(projects.id, projectInvites.projectId))
    .where(and(eq(projectInvites.tokenHash, tokenHash(c, c.req.param("token").slice(0, 128))), pending()));
  if (!row?.email) {
    await guesses.fail();
    throw notFound("Invitation");
  }
  const [account] = await db.select({ id: users.id }).from(users).where(eq(users.email, row.email));
  return c.json({ invite: { ...row, accountExists: Boolean(account) } });
});
