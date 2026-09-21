import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  and,
  authIdentities,
  type Database,
  eq,
  gt,
  isNull,
  ne,
  or,
  passwordCredentials,
  passwordResetTokens,
  sessions,
  users,
} from "@openmanga/db";
import { z } from "zod";

export const USERNAME_RE = /^[a-z0-9_][a-z0-9_.-]{2,31}$/;
export const RegisterInput = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(USERNAME_RE, "3-32 chars: letters, digits, _ . - (no leading . or -)"),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(10, "Password must be at least 10 characters").max(256),
  displayName: z.string().trim().max(80).optional(),
});
export type RegisterInput = z.infer<typeof RegisterInput>;

export const hashPassword = (password: string) =>
  Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

export async function verifyPassword(password: string, hash: string) {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

/** Dummy hash so unknown-user logins take similar time to real ones. */
let dummyHash: Promise<string> | undefined;
export const dummyVerify = async (password: string) => {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
  return false;
};

export const newOpaqueToken = () => randomBytes(32).toString("base64url");

export function hashToken(token: string, secret: string) {
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class AuthError extends Error {
  constructor(
    readonly code: "invalid_credentials" | "disabled" | "conflict" | "invalid_token" | "registration_disabled",
    message: string,
  ) {
    super(message);
  }
}

export type SessionUser = {
  id: string;
  username: string;
  email: string;
  displayName: string | null;
  role: "user" | "admin";
  status: "active" | "disabled";
  /** Account preferences that seed new projects. Typed from the column so auth needs no schema dependency. */
  settings: (typeof users.$inferSelect)["settings"];
};

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly opts: { secret: string; sessionTtlDays: number },
  ) {}

  async createUser(input: RegisterInput, role: "user" | "admin" = "user"): Promise<SessionUser> {
    const data = RegisterInput.parse(input);
    const passwordHash = await hashPassword(data.password);
    return this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(or(eq(users.username, data.username), eq(users.email, data.email)))
        .limit(1);
      if (existing.length) throw new AuthError("conflict", "Username or email is already in use");
      const [u] = await tx
        .insert(users)
        .values({ username: data.username, email: data.email, displayName: data.displayName ?? null, role })
        .returning();
      await tx.insert(passwordCredentials).values({ userId: u!.id, passwordHash });
      await tx
        .insert(authIdentities)
        .values({ userId: u!.id, provider: "local", providerSubject: u!.id, email: data.email });
      return toSessionUser(u!);
    });
  }

  /** Identifier may be username or email. */
  async verifyCredentials(identifier: string, password: string): Promise<SessionUser> {
    const id = identifier.trim().toLowerCase();
    const [row] = await this.db
      .select({ user: users, hash: passwordCredentials.passwordHash })
      .from(users)
      .innerJoin(passwordCredentials, eq(passwordCredentials.userId, users.id))
      .where(or(eq(users.username, id), eq(users.email, id)))
      .limit(1);
    if (!row) {
      await dummyVerify(password);
      throw new AuthError("invalid_credentials", "Invalid username/email or password");
    }
    if (!(await verifyPassword(password, row.hash)))
      throw new AuthError("invalid_credentials", "Invalid username/email or password");
    if (row.user.status !== "active") throw new AuthError("disabled", "This account is disabled");
    return toSessionUser(row.user);
  }

  async createSession(userId: string, meta: { ip?: string | null; userAgent?: string | null }) {
    const token = newOpaqueToken();
    const expiresAt = new Date(Date.now() + this.opts.sessionTtlDays * 86400_000);
    const [s] = await this.db
      .insert(sessions)
      .values({
        tokenHash: hashToken(token, this.opts.secret),
        userId,
        expiresAt,
        ip: meta.ip ?? null,
        userAgent: meta.userAgent?.slice(0, 300) ?? null,
      })
      .returning({ id: sessions.id });
    return { token, sessionId: s!.id, expiresAt };
  }

  async validateSession(token: string): Promise<{ sessionId: string; user: SessionUser; expiresAt: Date } | null> {
    if (!token || token.length > 128) return null;
    const [row] = await this.db
      .select({ s: sessions, u: users })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(
        and(
          eq(sessions.tokenHash, hashToken(token, this.opts.secret)),
          isNull(sessions.revokedAt),
          gt(sessions.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (row?.u.status !== "active") return null;
    if (Date.now() - row.s.lastUsedAt.getTime() > 5 * 60_000) {
      await this.db.update(sessions).set({ lastUsedAt: new Date() }).where(eq(sessions.id, row.s.id));
    }
    return { sessionId: row.s.id, user: toSessionUser(row.u), expiresAt: row.s.expiresAt };
  }

  /** Session rotation: revoke old, issue new (on login and privilege changes). */
  async rotateSession(
    oldSessionId: string | null,
    userId: string,
    meta: { ip?: string | null; userAgent?: string | null },
  ) {
    if (oldSessionId) await this.revokeSession(oldSessionId);
    return this.createSession(userId, meta);
  }

  async revokeSession(sessionId: string) {
    await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string) {
    // The exception is excluded from the UPDATE rather than un-revoked afterwards: clearing revokedAt would bring
    // an already-revoked session (an earlier logout, or an admin disabling the account) back to life.
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
          ...(exceptSessionId ? [ne(sessions.id, exceptSessionId)] : []),
        ),
      )
      .returning({ id: sessions.id });
    return rows.length;
  }

  async createPasswordReset(identifier: string): Promise<{ user: SessionUser; token: string } | null> {
    const id = identifier.trim().toLowerCase();
    const [u] = await this.db
      .select()
      .from(users)
      .where(or(eq(users.username, id), eq(users.email, id)))
      .limit(1);
    if (u?.status !== "active") return null;
    const token = newOpaqueToken();
    await this.db.insert(passwordResetTokens).values({
      userId: u.id,
      tokenHash: hashToken(token, this.opts.secret),
      expiresAt: new Date(Date.now() + 3600_000),
    });
    return { user: toSessionUser(u), token };
  }

  /** One-time, expiring. Revokes all sessions on success. */
  async resetPassword(token: string, newPassword: string) {
    const pw = RegisterInput.shape.password.parse(newPassword);
    const hash = await hashPassword(pw);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(passwordResetTokens.tokenHash, hashToken(token, this.opts.secret)),
            isNull(passwordResetTokens.usedAt),
            gt(passwordResetTokens.expiresAt, new Date()),
          ),
        )
        .returning({ userId: passwordResetTokens.userId });
      if (!row) throw new AuthError("invalid_token", "This reset link is invalid or has expired");
      await tx
        .update(passwordCredentials)
        .set({ passwordHash: hash })
        .where(eq(passwordCredentials.userId, row.userId));
      await tx
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(and(eq(sessions.userId, row.userId), isNull(sessions.revokedAt)));
      return row.userId;
    });
  }

  async changePassword(userId: string, current: string, next: string) {
    const [row] = await this.db.select().from(passwordCredentials).where(eq(passwordCredentials.userId, userId));
    if (!row || !(await verifyPassword(current, row.passwordHash)))
      throw new AuthError("invalid_credentials", "Current password is incorrect");
    const pw = RegisterInput.shape.password.parse(next);
    await this.db
      .update(passwordCredentials)
      .set({ passwordHash: await hashPassword(pw) })
      .where(eq(passwordCredentials.userId, userId));
  }
}

export function toSessionUser(u: typeof users.$inferSelect): SessionUser {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    status: u.status,
    settings: u.settings ?? {},
  };
}
