import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, setConfig } from "@openmanga/config";
import { createDb, sql } from "@openmanga/db";
import { runMigrations } from "@openmanga/db/migrate";
import { createWorker, OutboxDispatcher } from "@openmanga/queue";
import { bootstrapReferenceData } from "@openmanga/services";
import { createApp } from "../../apps/api/src/app.ts";
import { buildDeps } from "../../apps/api/src/deps.ts";
import { buildWorkerDeps } from "../../apps/worker/src/deps.ts";
import {
  assetProcessor,
  exportProcessor,
  generationProcessor,
  maintenanceProcessor,
  ttsProcessor,
} from "../../apps/worker/src/processors.ts";

/**
 * Boots API (in-process via app.request) + real BullMQ workers against a dedicated test database and
 * Redis DB 5, with AI_MOCK_MODE=true and the fake TTS provider.
 */
export async function startHarness() {
  const baseUrl = process.env.TEST_DATABASE_URL ?? "postgres://openmanga:openmanga@postgres:5432/openmanga";
  const dbName = `om_test_${Date.now()}`;
  const admin = createDb(baseUrl, { max: 1 });
  await admin.db.execute(sql.raw(`create database ${dbName}`));
  await admin.client.end();
  const dbUrl = baseUrl.replace(/\/[^/]+$/, `/${dbName}`);
  const assetRoot = await mkdtemp(join(tmpdir(), "om-assets-"));
  const tempRoot = await mkdtemp(join(tmpdir(), "om-tmp-"));
  const config = parseConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "error",
    DATABASE_URL: dbUrl,
    REDIS_URL: process.env.TEST_REDIS_URL ?? "redis://redis:6379/5",
    SESSION_SECRET: "test-secret-test-secret-test-secret-123",
    AI_MOCK_MODE: "true",
    TTS_PROVIDER: "fake",
    // The tests create their own accounts; the shipped default is closed registration.
    REGISTRATION_ENABLED: "true",
    ASSET_ROOT: assetRoot,
    TEMP_ROOT: tempRoot,
    APP_PUBLIC_URL: "http://test.local/app",
    API_PUBLIC_URL: "http://test.local/api",
    CDN_PUBLIC_URL: "http://test.local/cdn",
    DEV_MAILBOX_ENABLED: "true",
    RATE_LIMIT_PER_MINUTE: "100000",
    RATE_LIMIT_ANON_PER_MINUTE: "50000",
  });
  setConfig(config);
  await runMigrations(dbUrl);
  const deps = buildDeps(config);
  await deps.redis.flushdb();
  await bootstrapReferenceData(deps.db, config);
  const app = createApp(deps);

  const w = buildWorkerDeps(config);
  const gen = generationProcessor(w.deps);
  const workers = [
    createWorker("text-ai", w.redis, gen, { concurrency: 4 }),
    createWorker("image-generation", w.redis, gen, { concurrency: 4 }),
    createWorker("image-edit", w.redis, gen, { concurrency: 2 }),
    createWorker("tts", w.redis, ttsProcessor(w.deps), { concurrency: 2 }),
    createWorker("export", w.redis, exportProcessor(w.deps), { concurrency: 1 }),
    createWorker("asset-processing", w.redis, assetProcessor(w.deps)),
    createWorker("maintenance", w.redis, maintenanceProcessor(w.deps)),
  ];
  const stopOutbox = new OutboxDispatcher(w.deps.db, w.deps.queue).start(200);

  return {
    app,
    deps,
    workerDeps: w.deps,
    config,
    client: () => new TestClient(app),
    async stop() {
      stopOutbox();
      await Promise.allSettled(workers.map((x) => x.close()));
      await w.close();
      await deps.close();
      const a = createDb(baseUrl, { max: 1 });
      await a.db.execute(sql.raw(`drop database if exists ${dbName} with (force)`)).catch(() => {});
      await a.client.end();
      await rm(assetRoot, { recursive: true, force: true });
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

/** Cookie-jar client that behaves like the browser SPA (session cookie + CSRF header). */
export class TestClient {
  cookies = new Map<string, string>();
  constructor(private readonly app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {}

  async raw(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    if (!this.cookies.has("om_csrf") && method !== "GET") await this.raw("GET", "/api/auth/me");
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && this.cookies.get("om_csrf")) headers["x-csrf-token"] = this.cookies.get("om_csrf")!;
    let payload: BodyInit | undefined;
    if (body instanceof FormData) payload = body;
    else if (body instanceof Blob) {
      headers["content-type"] = body.type || "application/octet-stream";
      payload = body;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await this.app.request(`http://test.local${path}`, { method, headers, body: payload });
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const [k, ...v] = pair!.split("=");
      const value = v.join("=");
      if (/max-age=0/i.test(sc) || value === "") this.cookies.delete(k!.trim());
      else this.cookies.set(k!.trim(), value);
    }
    return res;
  }

  async json<T = Record<string, unknown>>(
    method: string,
    path: string,
    body?: unknown,
    expectStatus?: number,
  ): Promise<T> {
    const res = await this.raw(method, path, body);
    const text = await res.text();
    if (expectStatus !== undefined && res.status !== expectStatus)
      throw new Error(`${method} ${path} -> ${res.status} (expected ${expectStatus}): ${text.slice(0, 500)}`);
    if (expectStatus === undefined && res.status >= 400)
      throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }
  get = <T = Record<string, unknown>>(p: string, s?: number) => this.json<T>("GET", p, undefined, s);
  post = <T = Record<string, unknown>>(p: string, b?: unknown, s?: number) => this.json<T>("POST", p, b ?? {}, s);
  patch = <T = Record<string, unknown>>(p: string, b?: unknown, s?: number) => this.json<T>("PATCH", p, b ?? {}, s);
  put = <T = Record<string, unknown>>(p: string, b?: unknown, s?: number) => this.json<T>("PUT", p, b ?? {}, s);
  del = <T = Record<string, unknown>>(p: string, s?: number) => this.json<T>("DELETE", p, undefined, s);
}

export async function waitFor<T>(
  fn: () => Promise<T | null | undefined | false>,
  { timeoutMs = 30_000, intervalMs = 150, label = "condition" } = {},
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(intervalMs);
  }
}
