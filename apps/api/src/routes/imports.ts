import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, exportJobs, inArray, projectMembers, projects, sql } from "@openmanga/db";
import { ProjectSettings } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiError, badRequest, user } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const importRoutes = new Hono<AppEnv>();

// Configured by IMPORT_MAX_UPLOAD_MB; nginx's client_max_body_size on this route has to match.
const tooLarge = (mb: number) => new ApiError(413, "too_large", `Import files are limited to ${mb} MB`);
/**
 * A multipart body is materialised whole before anything can be written to disk, so that path keeps a small
 * ceiling. Larger packages are sent as a raw body and streamed straight through — the worker streams extraction,
 * and this is the other half of it.
 */
const MAX_MULTIPART_BYTES = 64 * 1024 * 1024;
const multipartTooLarge = () =>
  new ApiError(
    413,
    "too_large",
    `Multipart uploads are limited to ${Math.round(MAX_MULTIPART_BYTES / (1024 * 1024))} MB. Send the file as a raw body instead (any non-multipart content type, filename in ?name=), which is streamed to disk.`,
  );
const safeName = (raw: string | undefined, fallback: string) =>
  (raw ?? "").replace(/[^\w.\- ]/g, "_").slice(0, 200) || fallback;

doc({
  method: "POST",
  path: "/api/projects/import",
  summary:
    "Import a project from a OpenManga export. Send the file as a raw body (any non-multipart content type, filename in `?name=`), which is streamed to disk; multipart `file` is also accepted for uploads under 64 MB. Creates an empty project and queues a project_import job on it; watch /api/projects/:projectId/exports",
  tag: "exports",
});
importRoutes.post("/projects/import", async (c) => {
  const u = user(c);
  const deps = c.get("deps");
  const maxMb = deps.config.IMPORT_MAX_UPLOAD_MB;
  const maxBytes = maxMb * 1024 * 1024;
  const declared = Number(c.req.header("content-length") ?? 0);
  if (declared > maxBytes + 64_000) throw tooLarge(maxMb);
  const multipart = (c.req.header("content-type") ?? "").startsWith("multipart/form-data");
  // Checked before parsing, not after: `c.req.formData()` materialises the whole body, so a multipart upload past
  // this ceiling used to die inside that call and surface as a 502 instead of the 413 that explains the fix.
  // Content-length includes the multipart envelope, which only makes the ceiling slightly conservative.
  if (multipart && declared > MAX_MULTIPART_BYTES) throw multipartTooLarge();

  const dir = join(deps.config.TEMP_ROOT, "imports");
  await mkdir(dir, { recursive: true });
  const uploadPath = join(dir, `${crypto.randomUUID()}.upload`);
  let originalName = "import";
  let head = new Uint8Array(0);
  let bytes = 0;
  let title = "Imported project";

  try {
    if (multipart) {
      let form: FormData;
      try {
        form = await c.req.formData();
      } catch {
        throw badRequest("Expected multipart/form-data");
      }
      const file = form.get("file");
      if (!(file instanceof File)) throw badRequest('Missing file field "file"');
      if (file.size > maxBytes) throw tooLarge(maxMb);
      if (file.size > MAX_MULTIPART_BYTES) throw multipartTooLarge();
      originalName = safeName(file.name, "import");
      head = new Uint8Array(await file.slice(0, 256).arrayBuffer());
      bytes = file.size;
      await Bun.write(uploadPath, file);
    } else {
      const body = c.req.raw.body;
      if (!body) throw badRequest("Send the file as the request body, or as multipart/form-data");
      originalName = safeName(c.req.query("name") ?? c.req.header("x-file-name"), "import.zip");
      const sink = Bun.file(uploadPath).writer();
      const reader = body.getReader();
      const first: Uint8Array[] = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > maxBytes) throw tooLarge(maxMb);
          if (head.length < 256) {
            first.push(value.slice(0, 256));
            head = new Uint8Array(first.reduce((n, c2) => n + c2.byteLength, 0));
            let at = 0;
            for (const c2 of first) {
              head.set(c2, at);
              at += c2.byteLength;
            }
          }
          sink.write(value);
          await sink.flush();
        }
      } finally {
        await sink.end();
      }
      if (!bytes) throw badRequest("The upload was empty");
    }

    const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    const isJson = !isZip && /^\s*\{/.test(new TextDecoder().decode(head.slice(0, 256)));
    if (!isZip && !isJson) throw badRequest("Upload a OpenManga project .zip package or project .json export");

    // Cheap title peek for JSON (the ZIP's project.json is read by the worker).
    if (isJson && bytes <= 64 * 1024 * 1024) {
      try {
        const t = (JSON.parse(await Bun.file(uploadPath).text()) as { project?: { title?: unknown } }).project?.title;
        if (typeof t === "string" && t.trim()) title = t.trim().slice(0, 200);
      } catch {
        throw badRequest("The .json file is not valid JSON");
      }
    }
  } catch (e) {
    await rm(uploadPath, { force: true }).catch(() => {});
    throw e;
  }

  // Imports ride the render queue one at a time and each upload sits on disk until it is consumed, so a user
  // cannot stack them: without this, repeated 512 MB uploads fill the volume long before any is processed.
  const [pending] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.userId, u.id),
        eq(exportJobs.kind, "project_import"),
        inArray(exportJobs.status, ["queued", "processing"]),
      ),
    );
  if ((pending?.n ?? 0) >= 2) throw new ApiError(409, "conflict", "You already have an import in progress.");

  try {
    const { project, job } = await deps.db.transaction(async (tx) => {
      const settings = ProjectSettings.parse({
        narrationVoice: deps.config.KOKORO_DEFAULT_VOICE,
        narrationSpeed: deps.config.KOKORO_DEFAULT_SPEED,
        imageQuality: deps.config.IMAGE_QUALITY === "auto" ? "low" : deps.config.IMAGE_QUALITY,
      });
      const [p] = await tx.insert(projects).values({ ownerUserId: u.id, title, settings }).returning();
      await tx.insert(projectMembers).values({ projectId: p!.id, userId: u.id, role: "owner" });
      const j = await deps.jobs.createExportJob(tx, {
        projectId: p!.id,
        userId: u.id,
        kind: "project_import",
        options: { uploadPath, originalName },
      });
      return { project: p!, job: j };
    });
    await deps.jobs.kick();
    await recordAudit(deps.db, {
      userId: u.id,
      projectId: project.id,
      action: "project.import",
      targetId: job.id,
      metadata: { originalName, bytes },
      requestId: c.get("requestId"),
    });
    return c.json({ project, job }, 202);
  } catch (e) {
    await rm(uploadPath, { force: true }).catch(() => {});
    throw e;
  }
});
