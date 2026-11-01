import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegConvert } from "@openmanga/audio";
import { and, eq, generationJobs, inArray, narrationLines, narrationSegments, sql } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { attachImportedTake } from "@openmanga/services";
import { withTempDir } from "@openmanga/storage";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, type ProjectRecord, projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Narration recorded outside OpenManga: a whole recording cut into the segments it reads (queued, local Whisper), or
 * one take uploaded as one segment's audio. Both send the file as the raw request body, streamed to disk.
 */
export const narrationImportRoutes = new Hono<AppEnv>();

const ImportQuery = z.object({
  language: z.string().trim().min(2).max(16).optional(),
  name: z.string().max(300).optional(),
});

/** Streams the raw request body to `path`, refusing past `maxBytes`. */
async function receive(c: Context<AppEnv>, path: string, maxBytes: number) {
  const tooLarge = () =>
    new ApiError(413, "too_large", `Audio uploads are limited to ${Math.round(maxBytes / 2 ** 20)} MB`);
  if ((c.req.header("content-type") ?? "").startsWith("multipart/"))
    throw badRequest("Send the audio file itself as the request body, not as multipart/form-data");
  if (Number(c.req.header("content-length") ?? 0) > maxBytes) throw tooLarge();
  const body = c.req.raw.body;
  if (!body) throw badRequest("Send the audio file as the request body");
  const sink = Bun.file(path).writer();
  let bytes = 0;
  try {
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > maxBytes) throw tooLarge();
      sink.write(chunk);
      await sink.flush();
    }
  } finally {
    await sink.end();
  }
  if (!bytes) throw badRequest("The upload was empty");
}

async function queueImport(c: Context<AppEnv>, project: ProjectRecord, chapterId: string | null) {
  const deps = c.get("deps");
  const q = query(c, ImportQuery);
  const language = q.language || project.language;
  const [has] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .where(
      and(
        eq(narrationLines.projectId, project.id),
        eq(narrationLines.language, language),
        chapterId ? eq(narrationLines.chapterId, chapterId) : undefined,
      ),
    );
  if (!has?.n) throw badRequest(`There is no ${language} narration text to match a recording to; write it first`);
  // One at a time per project: each waits on disk until it runs, and the recogniser takes them in turn anyway.
  const [busy] = await deps.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, project.id),
        eq(generationJobs.kind, "narration_import"),
        inArray(generationJobs.status, ["queued", "processing"]),
      ),
    )
    .limit(1);
  if (busy) throw conflict("A narration recording is already being imported into this project; wait for it to finish");

  // ponytail: an import cancelled before it starts leaves its upload here (as a project import does); sweep the folder
  // in maintenance if that happens often.
  const dir = join(deps.config.TEMP_ROOT, "narration-imports");
  await mkdir(dir, { recursive: true });
  const uploadPath = join(dir, `${crypto.randomUUID()}.upload`);
  try {
    await receive(c, uploadPath, deps.config.IMPORT_MAX_UPLOAD_MB * 2 ** 20);
    const job = await deps.db.transaction((tx) =>
      deps.jobs.createGenerationJob(tx, {
        projectId: project.id,
        userId: user(c).id,
        kind: "narration_import",
        priority: PRIORITY.single,
        targetType: chapterId ? "chapter" : "project",
        targetId: chapterId ?? project.id,
        input: {
          uploadPath,
          language,
          chapterIds: chapterId ? [chapterId] : null,
          originalName: (q.name ?? "").slice(0, 200) || null,
        },
        // The worker deletes the upload when the job ends, so there is nothing to retry with.
        maxAttempts: 1,
      }),
    );
    await deps.jobs.kick();
    return c.json({ job }, 202);
  } catch (e) {
    await rm(uploadPath, { force: true }).catch(() => {});
    throw e;
  }
}

const importDoc =
  "Send the recording (any audio format ffmpeg reads) as the raw request body, filename in `?name=`. Queues a narration_import job: the recording is transcribed by the local Whisper service and each segment of the narration (in `?language=`, default the project's) whose words are found gets the matching stretch as its audio. Segments not found keep their audio; the job's result lists them.";
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/import",
  summary: `Import a recording of one chapter's narration. ${importDoc}`,
  tag: "narration",
  query: ImportQuery,
});
narrationImportRoutes.post("/chapters/:id/narration/import", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  return queueImport(c, project, chapterId);
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/narration/import",
  summary: `Import a recording of the whole project's narration, every chapter in order. ${importDoc}`,
  tag: "narration",
  query: ImportQuery,
});
narrationImportRoutes.post("/projects/:projectId/narration/import", async (c) => {
  const project = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  return queueImport(c, project, null);
});

doc({
  method: "POST",
  path: "/api/narration-segments/:id/audio",
  summary:
    "Upload one segment's audio, recorded elsewhere (any audio format ffmpeg reads, as the raw request body). It is converted, trimmed of leading and trailing silence and becomes the segment's take; it stays current until the segment's text changes",
  tag: "narration",
});
narrationImportRoutes.post("/narration-segments/:id/audio", async (c) => {
  const deps = c.get("deps");
  const [row] = await deps.db
    .select({ s: narrationSegments, language: narrationLines.language })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .where(eq(narrationSegments.id, uuidParam(c, "id")));
  if (!row) throw notFound("Narration segment");
  const project = await projectAccess(c, row.s.projectId, "generate");
  const audio = await withTempDir(deps.config.TEMP_ROOT, async (dir) => {
    const path = join(dir, "upload");
    await receive(c, path, deps.config.UPLOAD_MAX_BYTES);
    let wav: Uint8Array;
    try {
      wav = await ffmpegConvert(await Bun.file(path).bytes(), "wav", { tempDir: dir });
    } catch {
      throw badRequest("The file could not be read as audio");
    }
    return attachImportedTake(deps.db, deps.assets, {
      projectId: project.id,
      userId: user(c).id,
      segmentId: row.s.id,
      textSha256: row.s.textSha256,
      language: row.language,
      wav,
      trim: { thresholdDb: deps.config.TTS_TRIM_THRESHOLD_DB, keepMs: deps.config.TTS_TRIM_KEEP_MS },
      metadata: { sourceName: (c.req.query("name") ?? "").slice(0, 200) || null },
    });
  });
  if (!audio) throw conflict("The segment's text changed while its audio was uploading; upload it again");
  return c.json({ audio });
});
