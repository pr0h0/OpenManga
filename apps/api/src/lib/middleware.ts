import { createHmac, randomBytes } from "node:crypto";
import { safeEqual } from "@openmanga/auth";
import { and, eq, or, users } from "@openmanga/db";
import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Deps } from "../context.ts";
import { ApiError, clientIp } from "./http.ts";

export const SESSION_COOKIE = "om_session";
export const CSRF_COOKIE = "om_csrf";
export const CSRF_HEADER = "x-csrf-token";
/** Marks a browser that has signed in to an account before (see checkLoginThrottle). */
export const DEVICE_COOKIE = "om_device";

const deviceMac = (secret: string, userId: string) =>
  createHmac("sha256", secret).update(`login-device:${userId}`).digest("base64url");

/** After a successful sign-in: this browser is now a known device of the account, for a year. */
export function setDeviceCookie(c: Context<AppEnv>, userId: string) {
  const cfg = c.get("deps").config;
  setCookie(c, DEVICE_COOKIE, `${userId}.${deviceMac(cfg.SESSION_SECRET, userId)}`, {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: "Strict",
    path: "/api/auth",
    maxAge: 365 * 86_400,
  });
}

/** Whether this browser's device cookie is genuine and belongs to the account `identifier` names. */
async function knownDevice(c: Context<AppEnv>, identifier: string) {
  const [userId, mac] = (getCookie(c, DEVICE_COOKIE) ?? "").split(".");
  const { config, db } = c.get("deps");
  if (!userId || !mac || !safeEqual(mac, deviceMac(config.SESSION_SECRET, userId))) return false;
  const id = identifier.trim().toLowerCase();
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.id, userId), or(eq(users.username, id), eq(users.email, id))))
    .catch(() => []);
  return Boolean(row);
}

export function withDeps(deps: Deps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const requestId =
      c.req
        .header("x-request-id")
        ?.slice(0, 64)
        .replace(/[^\w-]/g, "") || crypto.randomUUID();
    c.set("deps", deps);
    c.set("requestId", requestId);
    c.set("log", deps.logger.child({ requestId }));
    c.set("user", null);
    c.set("sessionId", null);
    c.set("service", null);
    const started = performance.now();
    c.header("x-request-id", requestId);
    await next();
    const path = c.req.path;
    if (path !== "/healthz" && path !== "/readyz") {
      c.get("log").info("request", {
        method: c.req.method,
        path,
        status: c.res.status,
        latencyMs: Math.round(performance.now() - started),
        userId: c.get("user")?.id,
      });
    }
  };
}

export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.header("x-content-type-options", "nosniff");
  c.header("referrer-policy", "strict-origin-when-cross-origin");
  c.header("x-frame-options", "SAMEORIGIN");
  if (!c.res.headers.get("cache-control")) c.header("cache-control", "no-store");
};

/**
 * For a response that outlives its request (an event stream): whether the session it was opened with still holds.
 * Logout everywhere, a password change and a disabled account revoke it; a stream asks at every ping and ends.
 */
export function sessionStillValid(c: Context<AppEnv>): () => Promise<boolean> {
  const token = getCookie(c, SESSION_COOKIE);
  const { auth } = c.get("deps");
  return async () => Boolean(token && (await auth.validateSession(token).catch(() => null)));
}

export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    const s = await c.get("deps").auth.validateSession(token);
    if (s) {
      c.set("user", s.user);
      c.set("sessionId", s.sessionId);
    }
  }
  await next();
};

export function setSessionCookie(c: Parameters<MiddlewareHandler<AppEnv>>[0], token: string, expires: Date) {
  const cfg = c.get("deps").config;
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    expires,
  });
}

export function clearSessionCookie(c: Parameters<MiddlewareHandler<AppEnv>>[0]) {
  const cfg = c.get("deps").config;
  setCookie(c, SESSION_COOKIE, "", {
    httpOnly: true,
    secure: cfg.COOKIE_SECURE,
    sameSite: "Lax",
    path: "/",
    maxAge: 0,
  });
}

/** Double-submit CSRF token: readable cookie echoed in a header on unsafe methods. */
export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  let token = getCookie(c, CSRF_COOKIE);
  if (!token) {
    token = randomBytes(24).toString("base64url");
    setCookie(c, CSRF_COOKIE, token, {
      httpOnly: false,
      secure: c.get("deps").config.COOKIE_SECURE,
      sameSite: "Lax",
      path: "/",
    });
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
    const header = c.req.header(CSRF_HEADER) ?? "";
    const cookie = getCookie(c, CSRF_COOKIE) ?? "";
    if (!cookie || !header || !safeEqual(header, cookie))
      throw new ApiError(403, "csrf_failed", "Security token missing or invalid. Reload the page and try again.");
  }
  await next();
};

/** Fixed-window Redis rate limiter. Fails open if Redis is unavailable. */
export function rateLimit(opts: {
  key: string;
  /** `signedIn` lets one limiter give a session a higher ceiling than an anonymous address. */
  limit: (deps: Deps, signedIn: boolean) => number;
  windowSec: number;
  by?: "ip" | "user";
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const deps = c.get("deps");
    const who = opts.by === "user" ? (c.get("user")?.id ?? clientIp(c) ?? "anon") : (clientIp(c) ?? "unknown");
    const bucket = Math.floor(Date.now() / 1000 / opts.windowSec);
    const key = `om:rl:${opts.key}:${who}:${bucket}`;
    try {
      const n = await deps.redis.incr(key);
      if (n === 1) await deps.redis.expire(key, opts.windowSec + 1);
      const limit = opts.limit(deps, Boolean(c.get("user")));
      c.header("x-ratelimit-limit", String(limit));
      c.header("x-ratelimit-remaining", String(Math.max(0, limit - n)));
      if (n > limit) {
        c.header("retry-after", String(opts.windowSec));
        throw new ApiError(429, "rate_limited", "Too many requests. Please slow down.");
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
    }
    await next();
  };
}

/**
 * Caps wrong guesses at a secret — a token, a link, a current password — per client (or per user): past `max` failures
 * in the window every attempt answers 429, right or wrong, until the window ends. Successful requests cost nothing,
 * so real use never runs into it. Fails open like the other limiters.
 */
export async function failureGuard(c: Context<AppEnv>, scope: string, max: number, windowSec: number, who?: string) {
  const deps = c.get("deps");
  const key = `om:fail:${scope}:${who ?? clientIp(c) ?? "unknown"}`;
  const n = Number((await deps.redis.get(key).catch(() => null)) ?? 0);
  if (n >= max) {
    const ttl = await deps.redis.ttl(key).catch(() => windowSec);
    c.header("retry-after", String(Math.max(1, ttl)));
    throw new ApiError(429, "rate_limited", "Too many failed attempts. Please wait and try again later.");
  }
  return {
    async fail() {
      const count = await deps.redis.incr(key).catch(() => 0);
      if (count === 1) await deps.redis.expire(key, windowSec).catch(() => {});
    },
  };
}

/**
 * Login throttling with exponential lockout, counted twice: per identifier+IP, and per identifier alone at a
 * higher ceiling. The second counter is what a distributed attempt or a spoofed client address runs into, since
 * rotating the source only resets the first one.
 *
 * The second counter is also one anyone can fill for an account they do not own, from a handful of addresses, and
 * then the owner could not sign in either. So a browser that has signed in to that account before (a genuine device
 * cookie) is not held by it; it still answers to the first, per-address counter. A guesser has no such cookie.
 */
export async function checkLoginThrottle(c: Context<AppEnv>, identifier: string, ip: string | null) {
  const deps = c.get("deps");
  const id = identifier.toLowerCase();
  const keys: [string, number, boolean][] = [
    [`om:login:${id}:${ip ?? "?"}`, deps.config.LOGIN_MAX_ATTEMPTS, false],
    [`om:login:${id}`, deps.config.LOGIN_MAX_ATTEMPTS * 5, true],
  ];
  for (const [key, max, accountWide] of keys) {
    const n = Number((await deps.redis.get(key).catch(() => null)) ?? 0);
    if (n >= max && !(accountWide && (await knownDevice(c, identifier)))) {
      const ttl = await deps.redis.ttl(key).catch(() => 60);
      throw new ApiError(
        429,
        "login_throttled",
        `Too many failed sign-in attempts. Try again in ${Math.max(1, Math.ceil(ttl / 60))} minute(s).`,
      );
    }
  }
  return {
    async fail() {
      for (const [key, max] of keys) {
        const count = await deps.redis.incr(key).catch(() => 0);
        await deps.redis.expire(key, Math.min(3600, 60 * 2 ** Math.max(0, count - max + 1))).catch(() => {});
      }
    },
    async success() {
      await Promise.all(keys.map(([key]) => deps.redis.del(key).catch(() => {})));
    },
  };
}
