import { afterAll, beforeAll, expect, test } from "bun:test";
import { assets, eq, panels, sql, users } from "@openmanga/db";
import { runMaintenance } from "../../apps/worker/src/handlers/maintenance.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/**
 * The server's storage policy: only files the app can do without are candidates, the oldest go first, an approve
 * policy waits for an administrator (and says so on every page), an auto one deletes at the maintenance pass.
 */
let h: Awaited<ReturnType<typeof startHarness>>;
let admin: TestClient;
let member: TestClient;
let projectId = "";
const ids: Record<string, string> = {};

type View = {
  policy: { enabled: boolean; mode: string };
  usage: { totalBytes: number; expendable: Record<string, { files: number; bytes: number }> };
  preview: {
    files: number;
    bytes: number;
    reasons: { age: number; size: number };
    byKind: Record<string, unknown>;
  } | null;
  pending: { files: number; bytes: number; overLimitBytes: number } | null;
};

const file = async (
  name: string,
  type: "panel_art" | "audio" | "export",
  opts: { job?: boolean; meta?: Record<string, unknown> } = {},
) => {
  const a = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type,
    data: new Uint8Array(1000).fill(name.length),
    mimeType: type === "audio" ? "audio/wav" : "image/png",
    metadata: opts.meta ?? {},
  });
  if (opts.job) await h.deps.db.update(assets).set({ generationJobId: crypto.randomUUID() }).where(eq(assets.id, a.id));
  ids[name] = a.id;
  return a;
};
const age = (name: string, days: number) =>
  h.deps.db
    .update(assets)
    .set({ createdAt: new Date(Date.now() - days * 86_400_000) })
    .where(eq(assets.id, ids[name]!));
const exists = async (name: string) =>
  (await h.deps.db.select({ id: assets.id }).from(assets).where(eq(assets.id, ids[name]!))).length > 0;

beforeAll(async () => {
  h = await startHarness();
  admin = h.client();
  member = h.client();
  await admin.post(
    "/api/auth/register",
    { username: "keeper", email: "keeper@example.com", password: "keeper pw 123" },
    201,
  );
  await h.deps.db.update(users).set({ role: "admin" }).where(eq(users.username, "keeper"));
  await member.post(
    "/api/auth/register",
    { username: "plain", email: "plain@example.com", password: "plain pw 1234" },
    201,
  );
  projectId = (await admin.post<{ project: { id: string } }>("/api/projects", { title: "Store" }, 201)).project.id;
  const chapter = await admin.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "C" },
    201,
  );
  const page = await admin.post<{ page: { id: string } }>(
    `/api/chapters/${chapter.chapter.id}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  const [panel] = (await admin.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`)).panels;

  // Expendable: an older AI-drawn version and two narration takes no line plays. (Cached video sections and expired
  // exports are expendable too, but maintenance already sweeps the unclaimed ones on its own.)
  await file("oldVersion", "panel_art", { job: true });
  await file("oldTake", "audio");
  await file("newTake", "audio");
  // Kept whatever their age: the art a panel shows, an approved version, and an uploaded picture.
  await file("shown", "panel_art", { job: true });
  await h.deps.db.update(panels).set({ activeArtworkAssetId: ids.shown }).where(eq(panels.id, panel!.id));
  await file("approved", "panel_art", { job: true });
  await h.deps.db.update(assets).set({ status: "approved" }).where(eq(assets.id, ids.approved!));
  await file("upload", "panel_art");
  for (const n of ["oldVersion", "oldTake", "shown", "approved", "upload"]) await age(n, 40);
  await age("newTake", 2);
}, 60_000);
afterAll(() => h?.stop());

test("only administrators see or set it; candidates are the expendable files only", async () => {
  await member.get("/api/admin/storage", 403);
  await member.get("/api/admin/storage/alert", 403);
  const v = await admin.get<View>("/api/admin/storage");
  expect(v.policy.enabled).toBe(false);
  expect(v.preview).toBeNull();
  expect(Object.keys(v.usage.expendable).sort()).toEqual(["audio_take", "panel_version"]);
  expect(v.usage.expendable.panel_version!.files).toBe(1);
  expect(v.usage.expendable.audio_take!.files).toBe(2);
  await admin.put(
    "/api/admin/storage/policy",
    { enabled: true, maxAgeDays: null, maxTotalGb: null, mode: "auto" },
    422,
  );
});

test("approve: the due files wait, shown on every page to admins, until approved; in-use files are never touched", async () => {
  const v = await admin.put<View>("/api/admin/storage/policy", {
    enabled: true,
    maxAgeDays: 30,
    maxTotalGb: null,
    mode: "approve",
  });
  // Older than 30 days and expendable: the old version and the old take, not the 2-day-old take.
  expect(v.preview).toMatchObject({ files: 2, reasons: { age: 2, size: 0 } });
  expect(v.pending).toMatchObject({ files: 2 });
  expect((await admin.get<{ pending: { files: number } }>("/api/admin/storage/alert")).pending.files).toBe(2);
  // The hourly pass keeps waiting rather than deleting.
  await runMaintenance(h.workerDeps);
  expect(await exists("oldVersion")).toBe(true);
  expect((await admin.get<View>("/api/admin/storage")).pending?.files).toBe(2);

  const oldKey = (await h.deps.db.select().from(assets).where(eq(assets.id, ids.oldVersion!)))[0]!.storageKey;
  await admin.post("/api/admin/storage/approve", {}, 202);
  await waitFor(async () => !(await exists("oldVersion")) && !(await exists("oldTake")), { label: "deleted" });
  await waitFor(async () => (await admin.get<{ pending: unknown }>("/api/admin/storage/alert")).pending === null, {
    label: "alert cleared",
  });
  expect(await h.deps.assets.storage.exists(oldKey)).toBe(false);
  for (const kept of ["shown", "approved", "upload", "newTake"]) expect(await exists(kept)).toBe(true);
  await admin.post("/api/admin/storage/approve", {}, 409);
});

test("size: the oldest expendable files go until under the limit; what cannot be freed stays a warning", async () => {
  // A limit below what is in use: the take is the only expendable file left, and even without it the total is over.
  const v = await admin.put<View>("/api/admin/storage/policy", {
    enabled: true,
    maxAgeDays: null,
    maxTotalGb: 0.000001,
    mode: "auto",
  });
  expect(v.preview).toMatchObject({ files: 1, reasons: { age: 0, size: 1 } });
  await waitFor(async () => !(await exists("newTake")), { label: "auto deleted" });
  const after = await waitFor(
    async () => {
      const a = await admin.get<{ pending: { files: number; overLimitBytes: number } | null }>(
        "/api/admin/storage/alert",
      );
      return a.pending && a.pending.files === 0 ? a.pending : null;
    },
    { label: "over-limit warning" },
  );
  expect(after.overLimitBytes).toBeGreaterThan(0);
  for (const kept of ["shown", "approved", "upload"]) expect(await exists(kept)).toBe(true);
  const [audit] = await h.deps.db.execute<{ n: number }>(
    sql`select count(*)::int as n from audit_events where action in ('storage.policy_auto', 'storage.policy_approved')`,
  );
  expect(audit!.n).toBe(2);

  // Turning the policy off resolves the warning.
  await admin.put("/api/admin/storage/policy", { enabled: false, maxAgeDays: 30, maxTotalGb: 100, mode: "approve" });
  expect((await admin.get<{ pending: unknown }>("/api/admin/storage/alert")).pending).toBeNull();
});
