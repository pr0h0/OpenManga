import { Hono } from "hono";
import type { AppEnv, Deps } from "./context.ts";
import { handleError, notFound, requireUser } from "./lib/http.ts";
import { csrf, loadSession, rateLimit, securityHeaders, withDeps } from "./lib/middleware.ts";
import { adminRoutes } from "./routes/admin.ts";
import { aiRoutes } from "./routes/ai.ts";
import { assetRoutes, cdnRoutes } from "./routes/assets.ts";
import { audioRoutes } from "./routes/audio.ts";
import { authRoutes, devMailRoutes } from "./routes/auth.ts";
import { chapterRoutes } from "./routes/chapters.ts";
import { characterRoutes } from "./routes/characters.ts";
import { expertRoutes } from "./routes/experts.ts";
import { exportRoutes } from "./routes/exports.ts";
import { generationRoutes } from "./routes/generations.ts";
import { importRoutes } from "./routes/imports.ts";
import { pageRoutes } from "./routes/pages.ts";
import { projectRoutes } from "./routes/projects.ts";
import { referenceRoutes } from "./routes/references.ts";
import { storyRoutes } from "./routes/stories.ts";
import { healthRoutes, miscRoutes } from "./routes/system.ts";
import { usageRoutes } from "./routes/usage.ts";
import { videoRoutes } from "./routes/video.ts";
import { visionRoutes } from "./routes/vision.ts";
import { worldRoutes } from "./routes/world.ts";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => handleError(notFound("Route"), c));
  app.use("*", withDeps(deps), securityHeaders);

  app.route("/", healthRoutes);

  const cdn = new Hono<AppEnv>();
  cdn.use("*", loadSession);
  cdn.route("/", cdnRoutes);
  app.route("/cdn", cdn);

  const api = new Hono<AppEnv>();
  api.use(
    "*",
    loadSession,
    csrf,
    rateLimit({ key: "api", limit: (d) => d.config.RATE_LIMIT_PER_MINUTE, windowSec: 60, by: "user" }),
  );
  // Everything is authenticated except auth endpoints, public meta and docs.
  api.use("*", async (c, next) => {
    const path = c.req.path.replace(/^\/api/, "");
    const isPublic = path.startsWith("/auth/") || path === "/meta" || path.startsWith("/docs");
    if (!isPublic) return requireUser(c, next);
    await next();
  });
  api.route("/auth", authRoutes);
  api.route("/dev", devMailRoutes);
  api.route("/admin", adminRoutes);
  api.route("/projects", projectRoutes);
  api.route("/usage", usageRoutes);
  // Domain routers that own several top-level prefixes.
  for (const r of [
    storyRoutes,
    characterRoutes,
    worldRoutes,
    referenceRoutes,
    chapterRoutes,
    pageRoutes,
    generationRoutes,
    assetRoutes,
    audioRoutes,
    exportRoutes,
    videoRoutes,
    importRoutes,
    visionRoutes,
    miscRoutes,
    aiRoutes,
    expertRoutes,
  ])
    api.route("/", r);
  app.route("/api", api);
  return app;
}
