import { statfs } from "node:fs/promises";
import { RegisterInput } from "@openmanga/auth";
import {
  and,
  desc,
  eq,
  errorEvents,
  generationInputs,
  generationJobs,
  inArray,
  projects,
  providerRateSnapshots,
  sessions,
  sql,
  users,
} from "@openmanga/db";
import { credentialKeyStatus, recordAudit, rotateCredentials } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { body, conflict, notFound, query, requireAdmin, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { usageSummary } from "./usage.ts";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use("*", requireAdmin);

doc({ method: "GET", path: "/api/admin/overview", summary: "Operational statistics", tag: "admin" });
adminRoutes.get("/overview", async (c) => {
  const deps = c.get("deps");
  const [counts] = await deps.db.execute<Record<string, number>>(sql`select
    (select count(*)::int from users) as users,
    (select count(*)::int from users where status = 'disabled') as "disabledUsers",
    (select count(*)::int from projects) as projects,
    (select count(*)::int from generation_jobs) as "generationJobs",
    (select count(*)::int from generation_jobs where status = 'failed') as "failedJobs",
    (select count(*)::int from generation_jobs where status in ('queued','submitted','processing')) as "activeJobs",
    (select count(*)::int from audio_jobs where status = 'failed') as "failedAudioJobs",
    (select count(*)::int from export_jobs where status = 'failed') as "failedExports",
    (select count(*)::int from outbox where status = 'pending') as "outboxPending",
    (select coalesce(sum(byte_size),0)::float from assets) as "assetBytes",
    (select coalesce(sum(byte_size),0)::float from asset_variants) as "variantBytes",
    (select count(*)::int from assets) as assets`);
  const queues = await deps.queue.counts().catch(() => null);
  const tts = deps.tts ? await deps.tts.health() : { ok: false, state: "disabled" };
  let disk: { totalBytes: number; freeBytes: number } | null = null;
  try {
    const s = await statfs(deps.config.ASSET_ROOT);
    disk = { totalBytes: s.blocks * s.bsize, freeBytes: s.bavail * s.bsize };
  } catch {}
  const recentErrors = await deps.db.select().from(errorEvents).orderBy(desc(errorEvents.createdAt)).limit(25);
  return c.json({
    counts,
    queues,
    tts,
    disk,
    recentErrors,
    providers: deps.providers,
    mockMode: deps.config.AI_MOCK_MODE,
  });
});

doc({ method: "GET", path: "/api/admin/users", summary: "Users", tag: "admin" });
adminRoutes.get("/users", async (c) => {
  const rows = await c
    .get("deps")
    .db.select({
      u: users,
      projects: sql<number>`(select count(*)::int from projects where owner_user_id = "users"."id")`,
      lastSeen: sql<string | null>`(select max(last_used_at) from sessions where user_id = "users"."id")`,
    })
    .from(users)
    .orderBy(desc(users.createdAt));
  return c.json({ users: rows.map((r) => ({ ...r.u, projects: r.projects, lastSeen: r.lastSeen })) });
});

const CreateUser = RegisterInput.extend({ role: z.enum(["user", "admin"]).default("user") });
doc({
  method: "POST",
  path: "/api/admin/users",
  summary: "Create account (works when registration is disabled)",
  tag: "admin",
  body: CreateUser,
});
adminRoutes.post("/users", async (c) => {
  const input = await body(c, CreateUser);
  const deps = c.get("deps");
  const u = await deps.auth.createUser(input, input.role);
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: "admin.user_create",
    targetType: "user",
    targetId: u.id,
    requestId: c.get("requestId"),
  });
  return c.json({ user: u }, 201);
});

const PatchUser = z.object({
  status: z.enum(["active", "disabled"]).optional(),
  role: z.enum(["user", "admin"]).optional(),
});
doc({
  method: "PATCH",
  path: "/api/admin/users/:id",
  summary: "Disable/enable account or change role",
  tag: "admin",
  body: PatchUser,
});
adminRoutes.patch("/users/:id", async (c) => {
  const id = uuidParam(c, "id");
  const input = await body(c, PatchUser);
  if (id === user(c).id && (input.status === "disabled" || input.role === "user"))
    throw conflict("You cannot disable or demote yourself");
  const deps = c.get("deps");
  const [row] = await deps.db.update(users).set(input).where(eq(users.id, id)).returning();
  if (!row) throw notFound("User");
  if (input.status === "disabled" || input.role)
    await deps.db
      .update(sessions)
      .set({ revokedAt: new Date() })
      .where(and(eq(sessions.userId, id), sql`${sessions.revokedAt} is null`));
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: "admin.user_update",
    targetType: "user",
    targetId: id,
    metadata: input,
    requestId: c.get("requestId"),
  });
  return c.json({ user: row });
});

doc({ method: "GET", path: "/api/admin/projects", summary: "All projects", tag: "admin" });
adminRoutes.get("/projects", async (c) => {
  const rows = await c
    .get("deps")
    .db.select({ p: projects, owner: users.username })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.ownerUserId))
    .orderBy(desc(projects.updatedAt))
    .limit(500);
  return c.json({ projects: rows.map((r) => ({ ...r.p, owner: r.owner })) });
});

const JobsQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
doc({
  method: "GET",
  path: "/api/admin/jobs",
  summary: "Generation jobs across all projects",
  tag: "admin",
  query: JobsQuery,
});
adminRoutes.get("/jobs", async (c) => {
  const q = query(c, JobsQuery);
  const rows = await c
    .get("deps")
    .db.select({ j: generationJobs, project: projects.title })
    .from(generationJobs)
    .innerJoin(projects, eq(projects.id, generationJobs.projectId))
    .where(q.status ? inArray(generationJobs.status, q.status.split(",") as "failed"[]) : undefined)
    .orderBy(desc(generationJobs.createdAt))
    .limit(q.limit);
  return c.json({ jobs: rows.map((r) => ({ ...r.j, compiledPrompt: undefined, projectTitle: r.project })) });
});

doc({ method: "GET", path: "/api/admin/jobs/:id", summary: "Inspect any generation", tag: "admin" });
adminRoutes.get("/jobs/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  if (!job) throw notFound("Job");
  const inputs = await db.select().from(generationInputs).where(eq(generationInputs.jobId, id));
  return c.json({ job, inputs });
});

doc({ method: "POST", path: "/api/admin/jobs/:id/retry", summary: "Retry job", tag: "admin" });
adminRoutes.post("/jobs/:id/retry", async (c) => {
  const created = await c.get("deps").jobs.retryGeneration(uuidParam(c, "id"), user(c).id);
  if (!created) throw conflict("Only failed or cancelled jobs can be retried");
  return c.json({ job: created }, 202);
});

doc({ method: "POST", path: "/api/admin/jobs/:id/cancel", summary: "Cancel job", tag: "admin" });
adminRoutes.post("/jobs/:id/cancel", async (c) => {
  const result = await c.get("deps").jobs.cancelGeneration(uuidParam(c, "id"));
  if (result === "not_cancellable") throw conflict("Job cannot be cancelled");
  return c.json({ result });
});

doc({ method: "GET", path: "/api/admin/usage", summary: "Global API usage and cost", tag: "admin" });
adminRoutes.get("/usage", async (c) => c.json(await usageSummary(c.get("deps").db, null)));

const RateInput = z.object({
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  effectiveFrom: z.string().datetime(),
  textInputRate: z.number().min(0),
  cachedInputRate: z.number().min(0),
  textOutputRate: z.number().min(0),
  imageInputRate: z.number().min(0),
  imageOutputRate: z.number().min(0),
  imageUnitRate: z.number().min(0).default(0),
  characterRate: z.number().min(0).default(0),
  note: z.string().max(500).default(""),
});
doc({ method: "GET", path: "/api/admin/rates", summary: "Provider rate snapshots", tag: "admin" });
adminRoutes.get("/rates", async (c) => {
  const rows = await c
    .get("deps")
    .db.select()
    .from(providerRateSnapshots)
    .orderBy(desc(providerRateSnapshots.effectiveFrom));
  return c.json({ rates: rows });
});
doc({
  method: "POST",
  path: "/api/admin/rates",
  summary: "Add a provider rate snapshot (USD per 1M tokens)",
  tag: "admin",
  body: RateInput,
});
adminRoutes.post("/rates", async (c) => {
  const r = await body(c, RateInput);
  const deps = c.get("deps");
  const [row] = await deps.db
    .insert(providerRateSnapshots)
    .values({
      provider: r.provider,
      model: r.model,
      effectiveFrom: new Date(r.effectiveFrom),
      textInputRate: String(r.textInputRate),
      cachedInputRate: String(r.cachedInputRate),
      textOutputRate: String(r.textOutputRate),
      imageInputRate: String(r.imageInputRate),
      imageOutputRate: String(r.imageOutputRate),
      imageUnitRate: String(r.imageUnitRate),
      characterRate: String(r.characterRate),
      metadata: { note: r.note, createdBy: user(c).id },
    })
    .returning();
  deps.usage.invalidate();
  return c.json({ rate: row }, 201);
});

doc({
  method: "GET",
  path: "/api/admin/credentials/encryption",
  summary: "API-key encryption status: primary key id, configured key ids, rows per key, rows pending rotation",
  tag: "admin",
});
adminRoutes.get("/credentials/encryption", async (c) => {
  const deps = c.get("deps");
  return c.json(await credentialKeyStatus(deps.db, deps.credentials.ring));
});
doc({
  method: "POST",
  path: "/api/admin/credentials/rotate",
  summary: "Re-encrypt saved API keys with the primary encryption key now",
  tag: "admin",
});
adminRoutes.post("/credentials/rotate", async (c) => {
  const deps = c.get("deps");
  const r = await rotateCredentials(deps.db, deps.credentials.ring, { logger: deps.logger });
  await recordAudit(deps.db, {
    userId: user(c).id,
    action: "credentials.rotate",
    metadata: r,
    requestId: c.get("requestId"),
  });
  return c.json({ ...r, status: await credentialKeyStatus(deps.db, deps.credentials.ring) });
});

doc({ method: "POST", path: "/api/admin/maintenance", summary: "Queue maintenance cleanup now", tag: "admin" });
adminRoutes.post("/maintenance", async (c) => {
  await c
    .get("deps")
    .queue.enqueue(
      "maintenance",
      "cleanup",
      { requestedBy: user(c).id },
      { jobId: `manual-cleanup-${Date.now()}`, priority: 10, attempts: 1 },
    );
  return c.json({ ok: true }, 202);
});
