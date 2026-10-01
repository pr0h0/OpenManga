/**
 * bun db:seed — demo project with a short story, 2 characters, 1 location, 1 chapter, 2 pages, planned panels,
 * mock images and narration. Zero AI calls. Usage: bun db:seed [--owner <username>]
 * Without --owner a "demo" user is created with a random password printed once.
 *
 * bun db:seed --samples <url-or-path> [--samples ...] imports published sample projects (real artwork and
 * narration) instead of the mock demo. Each argument is a project ZIP package; it is read or downloaded, its
 * SHA-256 is printed, checked against a matching --sha256 when one is given, and handed to the same
 * project_import path the UI uses — so the worker must be running. Zero AI calls either way.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthService } from "@openmanga/auth";
import { getConfig } from "@openmanga/config";
import {
  and,
  asc,
  audioAssets,
  chapters,
  characters,
  createDb,
  eq,
  inArray,
  locations,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projectMembers,
  projectStyles,
  projects,
  referenceAssets,
  storyAnalyses,
  storyRevisions,
  stylePresets,
  users,
} from "@openmanga/db";
import { segmentNarration } from "@openmanga/domain";
import { probeImage } from "@openmanga/image-utils";
import { ProjectSettings } from "@openmanga/schemas";
import {
  AssetService,
  applyChapterPlan,
  applyStoryAnalysis,
  bootstrapReferenceData,
  JobService,
} from "@openmanga/services";
import { createAssetStorage, sha256Hex } from "@openmanga/storage";
import { mockChapterPlan, mockImagePng, mockNarration, mockStoryAnalysis, mockWav } from "@openmanga/testing";

const STORY = `Chapter 1: The Rooftop

Rain hammered the city as Woo Jin climbed onto the rooftop of Seoryeong High. Woo Jin pulled his soaked jacket tighter and stared at the neon skyline.
Footsteps echoed from the stairwell behind him. "Who's there?" Woo Jin asked.
Kim Do-yun stepped out of the shadows, calm and smiling. Kim Do-yun had been waiting for him.
"You shouldn't have come alone," Kim Do-yun said. The metal door slammed shut with a BANG.
Woo Jin clenched his fists. Whatever happened next, he would not run again.`;

const config = getConfig();
const argv = process.argv;
const ownerArg = argv.includes("--owner") ? argv[argv.indexOf("--owner") + 1] : undefined;
const repeated = (flag: string) =>
  argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : [])) as string[];
const sampleArgs = repeated("--samples");
const sampleHashes = repeated("--sha256");
const { db, client } = createDb(config.DATABASE_URL, { max: 2 });
await bootstrapReferenceData(db, config);
const assetsSvc = new AssetService(db, createAssetStorage(config), config);

let [owner] = ownerArg
  ? await db.select().from(users).where(eq(users.username, ownerArg.toLowerCase()))
  : await db.select().from(users).where(eq(users.username, "demo"));
if (!owner) {
  if (ownerArg) throw new Error(`User ${ownerArg} not found`);
  const password = randomBytes(9).toString("base64url");
  const auth = new AuthService(db, { secret: config.SESSION_SECRET, sessionTtlDays: config.SESSION_TTL_DAYS });
  await auth.createUser({ username: "demo", email: "demo@example.invalid", password });
  [owner] = await db.select().from(users).where(eq(users.username, "demo"));
  console.log(`Created user "demo" with password: ${password}`);
}

if (sampleArgs.length) {
  const jobs = new JobService(db);
  const dir = join(config.TEMP_ROOT, "imports");
  await mkdir(dir, { recursive: true });
  for (const [i, src] of sampleArgs.entries()) {
    const bytes = /^https?:\/\//.test(src)
      ? new Uint8Array(await (await fetch(src)).arrayBuffer())
      : new Uint8Array(await readFile(src));
    if (!bytes.length) throw new Error(`${src} is empty`);
    const sha = sha256Hex(bytes);
    const expected = sampleHashes[i];
    if (expected && expected.toLowerCase() !== sha) throw new Error(`${src} hashes to ${sha}, expected ${expected}`);
    const uploadPath = join(dir, `${crypto.randomUUID()}.zip`);
    await Bun.write(uploadPath, bytes);
    const { project: p, job } = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(projects)
        .values({
          ownerUserId: owner!.id,
          title: "Imported sample",
          settings: ProjectSettings.parse({}),
        })
        .returning();
      await tx.insert(projectMembers).values({ projectId: row!.id, userId: owner!.id, role: "owner" });
      const j = await jobs.createExportJob(tx, {
        projectId: row!.id,
        userId: owner!.id,
        kind: "project_import",
        options: { uploadPath, originalName: src.split("/").pop()?.slice(0, 200) ?? "sample.zip" },
      });
      return { project: row!, job: j };
    });
    console.log(`Queued import of ${src} (sha256 ${sha}) as project ${p.id}, export job ${job.id}`);
  }
  console.log(`${sampleArgs.length} sample import(s) queued for ${owner!.username}; the worker does the rest.`);
  await client.end();
  process.exit(0);
}

const [preset] = await db.select().from(stylePresets).where(eq(stylePresets.key, "manhwa"));
const [project] = await db
  .insert(projects)
  .values({
    ownerUserId: owner!.id,
    title: "Rain City (demo)",
    description: "A short demo project seeded without any API calls.",
    projectType: "manhwa",
    readingDirection: "ltr",
    settings: ProjectSettings.parse({ author: "OpenManga demo" }),
  })
  .returning();
const pid = project!.id;
await db.insert(projectMembers).values({ projectId: pid, userId: owner!.id, role: "owner" });
const [style] = await db
  .insert(projectStyles)
  .values({
    projectId: pid,
    versionNumber: 1,
    stylePresetId: preset?.id ?? null,
    customDescription: "Moody rain, teal and amber neon accents.",
  })
  .returning();
await db.update(projects).set({ currentStyleId: style!.id }).where(eq(projects.id, pid));

const [rev] = await db
  .insert(storyRevisions)
  .values({
    projectId: pid,
    revisionNumber: 1,
    source: "initial",
    inputKind: "story",
    title: "The Rooftop",
    content: STORY,
    contentSha256: sha256Hex(STORY),
    createdByUserId: owner!.id,
    lockedAt: new Date(),
  })
  .returning();
const analysis = mockStoryAnalysis(STORY);
analysis.characters = analysis.characters.filter((c) => ["Woo Jin", "Kim Do-yun"].includes(c.name));
analysis.locations = analysis.locations.slice(0, 1);
const [an] = await db
  .insert(storyAnalyses)
  .values({ projectId: pid, storyRevisionId: rev!.id, status: "completed", result: analysis })
  .returning();
await applyStoryAnalysis(db, an!.id, owner!.id);

// Approved canonical references (mock images) + small prompt derivatives.
const store = async (
  type: "character_reference" | "location_reference" | "panel_art",
  w: number,
  h: number,
  label: string,
  meta: Record<string, unknown>,
) => {
  const data = await mockImagePng({ width: w, height: h, prompt: `${label}-${pid}`, label });
  const p = await probeImage(data);
  const a = await assetsSvc.store({
    projectId: pid,
    ownerUserId: owner!.id,
    type,
    data,
    mimeType: p.mime,
    width: p.width,
    height: p.height,
    status: type === "panel_art" ? "draft" : "approved",
    metadata: { ...meta, seeded: true },
  });
  await assetsSvc.ensureThumbnail(a);
  return a;
};
for (const ch of await db.select().from(characters).where(eq(characters.projectId, pid))) {
  const a = await store("character_reference", 1024, 1536, `${ch.name} portrait`, { referenceKind: "portrait" });
  await db.insert(referenceAssets).values({
    projectId: pid,
    subjectType: "character",
    characterVersionId: ch.currentVersionId,
    kind: "portrait",
    assetId: a.id,
    status: "approved",
    isPrimary: true,
  });
  await assetsSvc.ensurePromptReference(a, assetsSvc.referenceParams());
}
for (const loc of await db.select().from(locations).where(eq(locations.projectId, pid))) {
  const a = await store("location_reference", 1536, 1024, `${loc.name} reference`, { referenceKind: "location" });
  await db.insert(referenceAssets).values({
    projectId: pid,
    subjectType: "location",
    locationVersionId: loc.currentVersionId,
    kind: "location",
    assetId: a.id,
    status: "approved",
    isPrimary: true,
  });
  await assetsSvc.ensurePromptReference(a, assetsSvc.referenceParams());
}

const [chapter] = await db.select().from(chapters).where(eq(chapters.projectId, pid));
const allChars = await db.select().from(characters).where(eq(characters.projectId, pid));
const allLocs = await db.select().from(locations).where(eq(locations.projectId, pid));
const plan = mockChapterPlan(
  {
    characters: allChars.map((c) => ({ key: c.analysisKey ?? c.name, name: c.name })),
    locations: allLocs.map((l) => ({ key: l.analysisKey ?? l.name, name: l.name })),
  },
  STORY,
  ["large-two-small", "four-grid"],
);
plan.scenes = plan.scenes.slice(0, 1);
await applyChapterPlan(db, chapter!.id, plan, { replace: true });

const pageRows = await db.select().from(pages).where(eq(pages.chapterId, chapter!.id)).orderBy(asc(pages.order));
const panelRows = await db
  .select()
  .from(panels)
  .where(
    inArray(
      panels.pageId,
      pageRows.map((p) => p.id),
    ),
  )
  .orderBy(asc(panels.order));
for (const pn of panelRows.slice(0, 5)) {
  const pg = pageRows.find((p) => p.id === pn.pageId)!;
  const ar = (pn.frame.width * pg.width) / (pn.frame.height * pg.height);
  const [w, h] = ar > 1.3 ? [1536, 1024] : ar < 0.77 ? [1024, 1536] : [1024, 1024];
  const a = await store("panel_art", w, h, `panel ${pn.order} (mock)`, { panelId: pn.id, pageId: pn.pageId });
  await db.update(panels).set({ activeArtworkAssetId: a.id, status: "ready" }).where(eq(panels.id, pn.id));
}

const draft = mockNarration(
  STORY,
  panelRows.map((p) => ({ id: p.id })),
);
let order = (await db.select().from(narrationLines).where(eq(narrationLines.chapterId, chapter!.id))).length;
for (const line of draft.lines.slice(0, 4)) {
  const panel = panelRows.find((p) => p.id === line.panelId);
  const [nl] = await db
    .insert(narrationLines)
    .values({
      projectId: pid,
      chapterId: chapter!.id,
      panelId: panel?.id ?? null,
      pageId: panel?.pageId ?? null,
      order: ++order,
      text: line.text,
    })
    .returning();
  for (const [i, seg] of segmentNarration(line.text).entries()) {
    const sha = sha256Hex(seg.text);
    const [s] = await db
      .insert(narrationSegments)
      .values({
        projectId: pid,
        narrationLineId: nl!.id,
        order: i,
        text: seg.text,
        textSha256: sha,
        pauseAfterMs: seg.pauseAfterMs,
      })
      .returning();
    const wav = mockWav(seg.text);
    const asset = await assetsSvc.store({
      projectId: pid,
      ownerUserId: owner!.id,
      type: "audio",
      data: wav.data,
      mimeType: "audio/wav",
      durationMs: wav.durationMs,
      metadata: { segmentId: s!.id, seeded: true },
    });
    await db.insert(audioAssets).values({
      projectId: pid,
      assetId: asset.id,
      segmentId: s!.id,
      textSha256: sha,
      voice: project!.settings.narrationVoice,
      speed: project!.settings.narrationSpeed,
      language: "en",
      provider: "fake-tts",
      modelVersion: "seed",
      sampleRate: wav.sampleRate,
      durationMs: wav.durationMs,
      format: "wav",
    });
    await db
      .update(narrationSegments)
      .set({ activeAudioAssetId: asset.id })
      .where(and(eq(narrationSegments.id, s!.id)));
  }
}

console.log(
  `Seeded demo project "${project!.title}" (${pid}) for user ${owner!.username}: ${pageRows.length} pages, ${panelRows.length} panels.`,
);
await client.end();
