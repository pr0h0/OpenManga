import { getConfig } from "@openmanga/config";
import { S3AssetStorage } from "@openmanga/storage";
import { createApp } from "./app.ts";
import { buildDeps } from "./deps.ts";
import { tickProductionRuns } from "./lib/production.ts";

const config = getConfig();
const deps = buildDeps(config);
const app = createApp(deps);

const server = Bun.serve({
  port: config.API_PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  idleTimeout: 0,
  // Must cover the largest import, or Bun closes the connection mid-upload and nginx reports a 502 with no
  // explanation. The route itself enforces IMPORT_MAX_UPLOAD_MB and answers 413; this is only the outer ceiling.
  maxRequestBodySize: Math.max(config.UPLOAD_MAX_BYTES, config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024) + 16 * 1024 * 1024,
});

deps.logger.info("api listening", { port: server.port, mockMode: config.AI_MOCK_MODE, providers: deps.providers });
const storage = deps.assets.storage;
if (storage instanceof S3AssetStorage) {
  // Browsers follow /cdn to this origin, so the app's CSP has to allow it (nginx's ASSET_CSP_ORIGIN).
  const origin = new URL(storage.presign("probe", { expiresIn: 60, contentType: "text/plain" })).origin;
  deps.logger.info("asset downloads redirect to the bucket", { origin });
  // A wrong endpoint, bucket or key otherwise only shows up as broken images; say so once, up front.
  await storage.check().catch((e) => deps.logger.error("the asset bucket is not reachable", { error: String(e) }));
}

// Production runs move on when their jobs finish; checking every 10 s is plenty for work measured in minutes.
const runTicker = setInterval(() => void tickProductionRuns(deps), 10_000);

const shutdown = async (signal: string) => {
  deps.logger.info("api shutting down", { signal });
  clearInterval(runTicker);
  server.stop();
  await deps.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
