import { Hono } from "hono";
import type { AppEnv, Deps } from "./context.ts";
import { trackActions } from "./lib/activity.ts";
import { handleError, notFound, requireUser } from "./lib/http.ts";
import { csrf, loadSession, rateLimit, securityHeaders, withDeps } from "./lib/middleware.ts";
import { oauthRoutes } from "./mcp/oauth.ts";
import { mcpRoutes } from "./mcp/server.ts";
import { activityRoutes } from "./routes/activity.ts";
import { adminRoutes } from "./routes/admin.ts";
import { agentRunRoutes } from "./routes/agent-runs.ts";
import { agentRoutes } from "./routes/agents.ts";
import { aiRoutes } from "./routes/ai.ts";
import { aiVideoRoutes } from "./routes/ai-video.ts";
import { assetRoutes, cdnRoutes } from "./routes/assets.ts";
import { audioRoutes } from "./routes/audio.ts";
import { authRoutes, devMailRoutes } from "./routes/auth.ts";
import { bibleRoutes } from "./routes/bible.ts";
import { boardRoutes } from "./routes/board.ts";
import { channelProfileRoutes } from "./routes/channel-profiles.ts";
import { chapterRoutes } from "./routes/chapters.ts";
import { characterRoutes } from "./routes/characters.ts";
import { commentRoutes } from "./routes/comments.ts";
import { compareRoutes } from "./routes/compare.ts";
import { continuityRoutes } from "./routes/continuity.ts";
import { coverageRoutes } from "./routes/coverage.ts";
import { duplicateRoutes } from "./routes/duplicates.ts";
import { expertRoutes } from "./routes/experts.ts";
import { exportRoutes } from "./routes/exports.ts";
import { generationRoutes } from "./routes/generations.ts";
import { imageToolRoutes } from "./routes/image-tools.ts";
import { importRoutes } from "./routes/imports.ts";
import { layoutRoutes } from "./routes/layouts.ts";
import { letteringTranslationRoutes } from "./routes/lettering-translations.ts";
import { locationStateRoutes } from "./routes/location-states.ts";
import { memberRoutes, publicInviteRoutes } from "./routes/members.ts";
import { narrationQaRoutes } from "./routes/narration-qa.ts";
import { pageRoutes } from "./routes/pages.ts";
import { productionRoutes } from "./routes/production.ts";
import { projectStorageRoutes } from "./routes/project-storage.ts";
import { projectRoutes } from "./routes/projects.ts";
import { promptLabRoutes } from "./routes/prompt-lab.ts";
import { publicSeriesRoutes, seriesPreviewRoutes } from "./routes/public-series.ts";
import { referenceRoutes } from "./routes/references.ts";
import { repurposeRoutes } from "./routes/repurpose.ts";
import { seriesRoutes } from "./routes/series.ts";
import { publicShareRoutes, shareRoutes } from "./routes/shares.ts";
import { storyRoutes } from "./routes/stories.ts";
import { healthRoutes, miscRoutes } from "./routes/system.ts";
import { timelineRoutes } from "./routes/timeline.ts";
import { usageRoutes } from "./routes/usage.ts";
import { videoRoutes } from "./routes/video.ts";
import { videoEditRoutes } from "./routes/video-edits.ts";
import { visionRoutes } from "./routes/vision.ts";
import { worldRoutes } from "./routes/world.ts";
import { youtubeAccountRoutes, youtubeRoutes } from "./routes/youtube.ts";

/**
 * Every REST route module, on one router. The public `/api` mounts it behind session, CSRF and rate limiting; the
 * MCP layer mounts the same modules on a private router (never reachable from outside), so an agent's call runs
 * exactly the handler a browser's does.
 */
export function mountApiRoutes(api: Hono<AppEnv>) {
  // Every caller of the routes (the browser, MCP tools, production runs) counts toward the user's local stats.
  api.use("*", trackActions);
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
    narrationQaRoutes,
    exportRoutes,
    videoRoutes,
    repurposeRoutes,
    importRoutes,
    visionRoutes,
    miscRoutes,
    aiRoutes,
    expertRoutes,
    shareRoutes,
    memberRoutes,
    commentRoutes,
    productionRoutes,
    bibleRoutes,
    continuityRoutes,
    channelProfileRoutes,
    seriesRoutes,
    youtubeRoutes,
    layoutRoutes,
    timelineRoutes,
    coverageRoutes,
    boardRoutes,
    imageToolRoutes,
    duplicateRoutes,
    compareRoutes,
    letteringTranslationRoutes,
    promptLabRoutes,
    projectStorageRoutes,
    videoEditRoutes,
    locationStateRoutes,
    aiVideoRoutes,
  ])
    api.route("/", r);
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => handleError(notFound("Route"), c));
  app.use("*", withDeps(deps), securityHeaders);

  app.route("/", healthRoutes);
  // MCP for agents: Bearer-authenticated, outside /api so no browser session or CSRF applies; its OAuth
  // authorization server and discovery documents sit beside it.
  app.route("/", oauthRoutes);
  app.route("/", mcpRoutes);
  // A series' reader page as crawlers see it (title, description, cover), sending people on to the app.
  app.route("/", seriesPreviewRoutes);

  const cdn = new Hono<AppEnv>();
  cdn.use("*", loadSession);
  cdn.route("/", cdnRoutes);
  app.route("/cdn", cdn);

  const api = new Hono<AppEnv>();
  api.use(
    "*",
    loadSession,
    csrf,
    rateLimit({
      key: "api",
      limit: (d, signedIn) => (signedIn ? d.config.RATE_LIMIT_PER_MINUTE : d.config.RATE_LIMIT_ANON_PER_MINUTE),
      windowSec: 60,
      by: "user",
    }),
  );
  // Everything is authenticated except auth endpoints, public meta and docs.
  api.use("*", async (c, next) => {
    const path = c.req.path.replace(/^\/api/, "");
    // Reader links are public by design: an unlisted, revocable token opens one project's pages read-only.
    const isPublic =
      path.startsWith("/auth/") || path === "/meta" || path.startsWith("/docs") || path.startsWith("/public/");
    if (!isPublic) return requireUser(c, next);
    await next();
  });
  mountApiRoutes(api);
  api.route("/public", publicShareRoutes);
  api.route("/public", publicInviteRoutes);
  api.route("/public", publicSeriesRoutes);
  // Managing agent access is for the signed-in user only: never mounted on the router MCP tools call.
  api.route("/agents", agentRoutes);
  // Your own usage stats, and an administrator's totals: the browser's alone, like agent access.
  api.route("/", activityRoutes);
  api.route("/", agentRunRoutes);
  // Connecting YouTube channels (an OAuth round trip in the browser) is likewise the signed-in user's alone.
  api.route("/youtube", youtubeAccountRoutes);
  app.route("/api", api);
  return app;
}
