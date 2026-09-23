import { sql } from "@openmanga/db";
import { LAYOUT_TEMPLATES } from "@openmanga/domain";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { build } from "../lib/build.ts";
import { ApiError, notFound, requireUser, user, uuidParam } from "../lib/http.ts";
import { docsHtml, openApiSpec } from "../lib/openapi.ts";

export const healthRoutes = new Hono<AppEnv>();

healthRoutes.get("/healthz", (c) => c.json({ ok: true, service: "api", time: new Date().toISOString() }));

/** Ready = API + Postgres + Redis. Kokoro is reported separately and never fails readiness. */
healthRoutes.get("/readyz", async (c) => {
  const deps = c.get("deps");
  const check = async (fn: () => Promise<unknown>) => {
    const t = performance.now();
    try {
      await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 2000))]);
      return { ok: true, latencyMs: Math.round(performance.now() - t) };
    } catch {
      // Unauthenticated endpoint: the driver's message would leak hosts, ports and auth failures to a stranger.
      return { ok: false };
    }
  };
  const [postgres, redis] = await Promise.all([
    check(() => deps.db.execute(sql`select 1`)),
    check(() => deps.redis.ping()),
  ]);
  const tts = deps.tts ? await deps.tts.health() : { ok: false, state: "disabled" };
  const ok = postgres.ok && redis.ok;
  return c.json({ ok, checks: { api: { ok: true }, postgres, redis }, optional: { kokoro: tts } }, ok ? 200 : 503);
});

export const miscRoutes = new Hono<AppEnv>();

miscRoutes.get("/meta", (c) => {
  const deps = c.get("deps");
  return c.json({
    /** Which build is answering — the same label the app header shows, so "is it deployed yet" has an answer. */
    build,
    layouts: LAYOUT_TEMPLATES,
    providers: deps.providers,
    mockMode: deps.config.AI_MOCK_MODE,
    ttsEnabled: deps.config.TTS_ENABLED,
    urls: { app: deps.urls.appUrl(), api: deps.urls.apiUrl(), cdn: deps.urls.cdnUrl() },
    referenceDefaults: {
      maxWidth: deps.config.REFERENCE_MAX_WIDTH,
      maxHeight: deps.config.REFERENCE_MAX_HEIGHT,
      fit: deps.config.REFERENCE_FIT,
    },
  });
});

miscRoutes.get("/docs", (c) => {
  if (!c.get("deps").config.API_DOCS_ENABLED) throw notFound();
  return c.html(docsHtml());
});
miscRoutes.get("/docs/openapi.json", (c) => {
  if (!c.get("deps").config.API_DOCS_ENABLED) throw notFound();
  return c.json(
    openApiSpec(
      c
        .get("deps")
        .urls.apiUrl()
        .replace(/\/api\/?$/, ""),
    ),
  );
});

/**
 * Open SSE streams per user. Each subscription holds its own Redis connection (pub/sub cannot share one with the
 * command client), so without a cap one account can exhaust Redis connections — and the rate limiter fails open
 * when Redis is unreachable, which would take the limits down with it.
 */
const MAX_STREAMS_PER_USER = 8;
const streamsPerUser = new Map<string, number>();
/** A client that opens the stream and stops reading must not accumulate events in API memory forever. */
const MAX_QUEUED_EVENTS = 500;

/** Server -> browser project events over SSE (nginx has buffering disabled for this path). */
miscRoutes.get("/projects/:projectId/events", requireUser, async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const deps = c.get("deps");
  const userId = user(c).id;
  const open = streamsPerUser.get(userId) ?? 0;
  if (open >= MAX_STREAMS_PER_USER)
    throw new ApiError(429, "too_many_streams", "Too many open event streams. Close a tab and try again.");
  streamsPerUser.set(userId, open + 1);
  c.header("x-accel-buffering", "no");
  c.header("cache-control", "no-cache, no-transform");
  return streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = deps.events.subscribe(deps.config.REDIS_URL, p.id, (msg) => {
      if (queue.length >= MAX_QUEUED_EVENTS) queue.shift();
      queue.push(msg);
      wake?.();
    });
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: JSON.stringify({ projectId: p.id }) });
    let lastPing = Date.now();
    try {
      while (!closed) {
        if (!queue.length) {
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000);
          });
          wake = null;
        }
        while (queue.length) await stream.writeSSE({ event: "message", data: queue.shift()! });
        if (Date.now() - lastPing > 14_000) {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
          lastPing = Date.now();
        }
      }
    } finally {
      await unsubscribe();
      const n = (streamsPerUser.get(userId) ?? 1) - 1;
      if (n > 0) streamsPerUser.set(userId, n);
      else streamsPerUser.delete(userId);
    }
  });
});
