import { AuthError } from "@openmanga/auth";
import { type SQLWrapper, sql } from "@openmanga/db";
import { ProviderError } from "@openmanga/domain";
import { PlanningError } from "@openmanga/services";
import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AppEnv } from "../context.ts";

export class ApiError extends Error {
  constructor(
    readonly status: 400 | 401 | 402 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "Resource") => new ApiError(404, "not_found", `${what} not found`);
export const forbidden = () => new ApiError(403, "forbidden", "You do not have permission to do that");
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const badRequest = (msg: string, details?: unknown) => new ApiError(400, "bad_request", msg, details);

/** Sanitized error responses: never leak stack traces or provider internals. */
export function handleError(err: Error, c: Context<AppEnv>) {
  const requestId = c.get("requestId");
  const log = c.get("log");
  if (err instanceof ApiError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details, requestId } }, err.status);
  }
  if (err instanceof z.ZodError) {
    return c.json(
      {
        error: {
          code: "validation_error",
          message: "Invalid input",
          details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          requestId,
        },
      },
      422,
    );
  }
  if (err instanceof AuthError) {
    const status =
      err.code === "conflict"
        ? 409
        : err.code === "registration_disabled"
          ? 403
          : err.code === "invalid_token"
            ? 400
            : 401;
    return c.json({ error: { code: err.code, message: err.message, requestId } }, status);
  }
  if (err instanceof PlanningError) {
    return c.json({ error: { code: "planning_error", message: err.message, requestId } }, err.status);
  }
  if (err instanceof ProviderError) {
    const rejected = err.code === "invalid_request" || err.code === "content_policy" || err.code === "synthesis_error";
    return c.json(
      { error: { code: `provider_${err.code}`, message: err.userMessage, requestId } },
      rejected ? 422 : 503,
    );
  }
  // Drizzle's refusal of an update with nothing in it: a PATCH whose body named no field (`{}`) or only unknown ones.
  // One check here rather than a non-empty refinement on every patch schema.
  if (err.message === "No values to set") {
    return c.json(
      { error: { code: "validation_error", message: "Nothing to update: name at least one field", requestId } },
      422,
    );
  }
  if (err instanceof HTTPException) {
    return c.json({ error: { code: "http_error", message: err.message, requestId } }, err.status);
  }
  log?.error("unhandled error", { error: err, requestId });
  const deps = c.get("deps");
  if (deps) {
    import("@openmanga/services")
      .then(({ recordError }) =>
        recordError(deps.db, { source: "api", message: err.message, requestId, metadata: { path: c.req.path } }),
      )
      .catch(() => {});
  }
  return c.json(
    { error: { code: "internal_error", message: "Something went wrong. Please try again.", requestId } },
    500,
  );
}

export async function body<T extends z.ZodType>(c: Context<AppEnv>, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw badRequest("Request body must be valid JSON");
  }
  return schema.parse(json);
}

export function query<T extends z.ZodType>(c: Context<AppEnv>, schema: T): z.infer<T> {
  return schema.parse(c.req.query());
}

/**
 * A timestamp to the microsecond, as the database keeps it, for a page cursor. `Date.toISOString()` keeps
 * milliseconds, so the next page asked for rows before `.123000` and skipped every row of the same millisecond after
 * the boundary (a bulk run's jobs share one timestamp).
 */
export const cursorTime = (col: SQLWrapper) =>
  sql<string>`to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const uuidParam = (c: Context<AppEnv>, name: string) => {
  const v = c.req.param(name);
  if (!v || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) throw notFound();
  return v;
};

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("user")) throw new ApiError(401, "unauthenticated", "Please sign in");
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const u = c.get("user");
  if (!u) throw new ApiError(401, "unauthenticated", "Please sign in");
  if (u.role !== "admin") throw forbidden();
  await next();
};

export const user = (c: Context<AppEnv>) => {
  const u = c.get("user");
  if (!u) throw new ApiError(401, "unauthenticated", "Please sign in");
  return u;
};

/**
 * Only `X-Real-IP` is trusted, and only because the bundled nginx overwrites it with the connection's own address
 * (after `real_ip` has applied CF-Connecting-IP from a proxy on our network). Reading a client-supplied
 * `CF-Connecting-IP` or `X-Forwarded-For` here would let anyone rotate the value that rate limiting keys on.
 * Behind a different proxy, make it set `X-Real-IP` the same way.
 */
export const clientIp = (c: Context<AppEnv>) => c.req.header("x-real-ip")?.trim() || null;
