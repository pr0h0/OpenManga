import { createHash } from "node:crypto";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { ApiError, handleError, notFound } from "../lib/http.ts";
import { withDeps } from "../lib/middleware.ts";
import type { McpActor } from "./context.ts";

/**
 * The private router MCP tools call: the very same route modules as `/api`, so validation, access checks, budget,
 * lifecycle rules and audit are the REST behaviour by construction. It is never mounted on a public path, the actor
 * arrives as a Hono binding (not a header anyone could send), and there is no CSRF because there is no browser.
 */

/** Paths an agent must never reach, whatever a tool asks for: accounts, admin, keys, and the dev mailbox. */
const FORBIDDEN = [/^\/api\/auth(\/|$)/, /^\/api\/admin(\/|$)/, /^\/api\/dev(\/|$)/, /^\/api\/ai\/credentials(\/|$)/];

const routers = new WeakMap<Deps, Hono<AppEnv>>();
async function internalRouter(deps: Deps) {
  let app = routers.get(deps);
  if (app) return app;
  // Loaded here, not at the top: app.ts mounts the MCP server, which imports the tools, which import this file.
  const { mountApiRoutes } = await import("../app.ts");
  app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => handleError(notFound("Route"), c));
  app.use("*", withDeps(deps), async (c, next) => {
    if (FORBIDDEN.some((r) => r.test(c.req.path))) throw notFound("Route");
    const { actor } = c.env as { actor: McpActor };
    c.set("user", actor.user);
    c.set("service", { serviceId: actor.serviceId, projectAccess: actor.projectAccess, projectIds: actor.projectIds });
    await next();
  });
  const api = new Hono<AppEnv>();
  mountApiRoutes(api);
  app.route("/api", api);
  routers.set(deps, app);
  return app;
}

/** A failure a tool reports to the model: the REST error envelope, kept intact. */
export class McpToolError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

export type InvokeOptions = {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  headers?: Record<string, string>;
  requestId?: string;
};

/**
 * Calls an OpenManga route as the actor, in-process. Resolves with the parsed JSON body (or `{}` for an empty one);
 * rejects with {@link McpToolError} carrying the route's own error code, message and details.
 */
export async function invoke<T = Record<string, unknown>>(
  deps: Deps,
  actor: McpActor,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  opts: InvokeOptions = {},
): Promise<T> {
  const url = new URL(path, "http://internal");
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.requestId) headers["x-request-id"] = opts.requestId;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await (await internalRouter(deps)).request(
    url.pathname + url.search,
    { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) },
    { actor },
  );
  const text = await res.text();
  let json: unknown = {};
  if (text && (res.headers.get("content-type") ?? "").includes("json")) {
    try {
      json = JSON.parse(text);
    } catch {
      json = {};
    }
  }
  if (!res.ok) {
    const e = (json as { error?: { code?: string; message?: string; details?: unknown } }).error ?? {};
    const retry = Number(res.headers.get("retry-after") ?? "") || undefined;
    throw new McpToolError(
      res.status,
      e.code ?? "http_error",
      e.message ?? `Request failed (${res.status})`,
      e.details,
      retry,
    );
  }
  return json as T;
}

/** Like {@link invoke}, for a route that answers with bytes (a rendered page image) rather than JSON. */
export async function invokeBinary(
  deps: Deps,
  actor: McpActor,
  path: string,
  opts: Pick<InvokeOptions, "query" | "requestId"> = {},
): Promise<{ data: Uint8Array; mimeType: string }> {
  const url = new URL(path, "http://internal");
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = opts.requestId ? { "x-request-id": opts.requestId } : {};
  const res = await (await internalRouter(deps)).request(
    url.pathname + url.search,
    { method: "GET", headers },
    { actor },
  );
  if (!res.ok) {
    const e = ((await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } }).error ?? {};
    throw new McpToolError(res.status, e.code ?? "http_error", e.message ?? `Request failed (${res.status})`);
  }
  return {
    data: new Uint8Array(await res.arrayBuffer()),
    mimeType: res.headers.get("content-type") ?? "application/octet-stream",
  };
}

/** Errors raised by MCP code itself (not by a route) use the same shape. */
export const toolError = (status: number, code: string, message: string, details?: unknown) =>
  new McpToolError(status, code, message, details);

export function asToolError(e: unknown): McpToolError {
  if (e instanceof McpToolError) return e;
  if (e instanceof ApiError) return new McpToolError(e.status, e.code, e.message, e.details);
  if (e && typeof e === "object" && "issues" in e)
    return new McpToolError(422, "validation_error", "Invalid input", (e as { issues: unknown }).issues);
  return new McpToolError(500, "internal_error", "Something went wrong. Please try again.");
}

/** A stable hash of JSON arguments (keys sorted), for idempotency and approval identity. */
export function argsHash(v: unknown) {
  const canon = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(canon)
      : x && typeof x === "object"
        ? Object.fromEntries(
            Object.keys(x as object)
              .sort()
              .map((k) => [k, canon((x as Record<string, unknown>)[k])]),
          )
        : x;
  return createHash("sha256")
    .update(JSON.stringify(canon(v ?? null)))
    .digest("hex");
}
