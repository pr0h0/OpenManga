import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { cardFrames, shotGroups, timeGroup, watermarkBox } from "@openmanga/domain";
import { sharp } from "@openmanga/image-utils";
import { unzipSync } from "fflate";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// Needs ffmpeg/ffprobe (present in the app image, not in the plain bun test image).
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;

type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
let u: TestClient;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  // Signed in for every test, so any one of them runs on its own (bun test -t).
  await u.post("/api/auth/register", { username: "vid", email: "vid@example.com", password: "video password 1" }, 201);
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

const waitJob = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string; failureReason: string | null } }>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

/** A planned, drawn, narrated and voiced first chapter of a new project. */
async function narratedChapter(title: string, extra: Record<string, unknown> = {}) {
  const p = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title, story: { content: STORY, inputKind: "story" }, ...extra },
    201,
  );
  const projectId = p.project.id;
  const story = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${story.latest.id}/analyze`,
    {},
    202,
  );
  expect((await waitJob(a.job.id)).status).toBe("completed");
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  const chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!
    .id;
  const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202);
  expect((await waitJob(plan.job.id)).status).toBe("completed");
  const bulk = await u.post<{ batchId: string }>(
    `/api/projects/${projectId}/generations/bulk`,
    { scope: { chapterId }, onlyMissing: true, confirm: true },
    202,
  );
  await waitFor(
    async () => {
      const r = await u.get<{ progress: { total: number; completed: number } }>(
        `/api/generations/batches/${bulk.batchId}`,
      );
      return r.progress.completed === r.progress.total ? r : null;
    },
    { label: "panels", timeoutMs: 90_000 },
  );
  const n = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/narration/generate`, {}, 202);
  expect((await waitJob(n.job.id)).status).toBe("completed");
  await u.post(`/api/chapters/${chapterId}/narration/synthesize`, { onlyMissing: true }, 202);
  await waitFor(
    async () => {
      const r = await u.get<{ lines: { segments: { audio: unknown }[] }[] }>(`/api/chapters/${chapterId}/narration`);
      return r.lines.length && r.lines.every((l) => l.segments.every((s) => s.audio)) ? r : null;
    },
    { label: "tts", timeoutMs: 60_000 },
  );
  return { projectId, chapterId };
}

type ExportFile = { assetId: string; fileName: string; mimeType: string };
/** Starts an export and waits for it to finish; fails the test unless it completed. */
async function runExport(projectId: string, body: Record<string, unknown>) {
  const ex = await u.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { acknowledgeIssues: true, ...body },
    202,
  );
  const done = await waitFor(
    async () => {
      const r = await u.get<{ job: { status: string; failureReason: string | null; files: ExportFile[] } }>(
        `/api/jobs/${ex.job.id}`,
      );
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: `${String(body.kind)} export`, timeoutMs: 240_000 },
  );
  expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
  return { id: ex.job.id, files: done.files };
}

/** What the preview's timing reads from a shot. */
type PreviewTiming = {
  joinNext: boolean;
  lines: {
    startOffsetMs: number;
    endOffsetMs: number;
    segments: { durationMs: number | null; pauseAfterMs: number }[];
  }[];
};
/** The preview's length in frames, from the same shared helpers as the render (without cards). */
function previewFrames(shots: PreviewTiming[], fps: number, minHoldMs: number) {
  let frames = 0;
  for (const g of shotGroups(shots.map((s) => s.joinNext))) {
    const members = shots.slice(g.first, g.last + 1);
    frames += timeGroup(
      members.flatMap((s) =>
        s.lines.map((l) => ({
          ...l,
          segments: l.segments
            .filter((x) => x.durationMs)
            .map((x) => ({ ms: x.durationMs!, pauseAfterMs: x.pauseAfterMs })),
        })),
      ),
      members.length,
      { minHoldMs, fps },
    ).totalFrames;
  }
  return frames;
}

/** Duration and video size of an exported MP4. */
async function probe(assetId: string) {
  const path = `${process.env.TMPDIR ?? "/tmp"}/mf-probe-${assetId}.mp4`;
  await Bun.write(path, new Uint8Array(await (await u.raw("GET", `/cdn/a/${assetId}`)).arrayBuffer()));
  const info = JSON.parse(
    Bun.spawnSync([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ]).stdout.toString(),
  ) as { streams: { codec_type: string; width?: number; height?: number }[]; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_type === "video")!;
  return { path, ms: Number(info.format.duration) * 1000, width: video.width!, height: video.height! };
}

describe.skipIf(!hasFfmpeg)("video export (page cut)", () => {
  test("renders an MP4 whose length matches the narration, holding silent pages for the minimum", async () => {
    const p = await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Video", story: { content: STORY, inputKind: "story" } },
      201,
    );
    const projectId = p.project.id;
    const story = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
    const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    expect((await waitJob(a.job.id)).status).toBe("completed");
    await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
    const chs = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    const chapterId = chs.chapters[0]!.id;
    const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202);
    expect((await waitJob(plan.job.id)).status).toBe("completed");
    const bulk = await u.post<{ batchId: string }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: true, confirm: true },
      202,
    );
    await waitFor(
      async () => {
        const r = await u.get<{ progress: { total: number; completed: number } }>(
          `/api/generations/batches/${bulk.batchId}`,
        );
        return r.progress.completed === r.progress.total ? r : null;
      },
      { label: "panels", timeoutMs: 90_000 },
    );
    const n = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/narration/generate`, {}, 202);
    expect((await waitJob(n.job.id)).status).toBe("completed");
    await u.post(`/api/chapters/${chapterId}/narration/synthesize`, { onlyMissing: true }, 202);
    await waitFor(
      async () => {
        const r = await u.get<{ lines: { segments: { audio: unknown }[] }[] }>(`/api/chapters/${chapterId}/narration`);
        return r.lines.length && r.lines.every((l) => l.segments.every((s) => s.audio)) ? r : null;
      },
      { label: "tts", timeoutMs: 60_000 },
    );
    const timeline = await u.get<{ totalDurationMs: number }>(`/api/chapters/${chapterId}/narration/timeline`);

    const ex = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_pages", chapterId, video: { height: 720, fps: 24, minHoldMs: 2000 }, acknowledgeIssues: true },
      202,
    );
    const done = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: {
            id: string;
            status: string;
            failureReason: string | null;
            files: { assetId: string; fileName: string; mimeType: string }[];
          }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === ex.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "video export", timeoutMs: 240_000 },
    );
    expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
    const f = done.files[0]!;
    expect(f.mimeType).toBe("video/mp4");
    expect(f.fileName).toContain("page-cut_720p.mp4");
    // The chapter number and title are in the name, so two chapters' videos cannot be confused on disk.
    expect(f.fileName).toContain("_ch01_");
    // ...and in the history, where every video of a project otherwise looks identical.
    const listed = await u.get<{ jobs: { id: string; chapter: { order: number } | null }[] }>(
      `/api/projects/${projectId}/exports`,
    );
    expect(listed.jobs.find((x) => x.id === ex.job.id)?.chapter?.order).toBe(1);
    const res = await u.raw("GET", `/cdn/a/${f.assetId}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(new TextDecoder().decode(buf.slice(4, 8))).toBe("ftyp");
    const path = `${process.env.TMPDIR ?? "/tmp"}/mf-video-test.mp4`;
    await Bun.write(path, buf);
    const probe = Bun.spawnSync([
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      path,
    ]);
    const info = JSON.parse(probe.stdout.toString()) as {
      streams: { codec_type: string; width?: number; height?: number }[];
      format: { duration: string };
    };
    expect(info.streams.find((s) => s.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });
    expect(info.streams.find((s) => s.codec_type === "audio")).toBeTruthy();
    expect(info.streams.some((s) => s.codec_type === "audio")).toBe(true);
    // At least all narration, plus minimum holds for any silent pages.
    expect(Number(info.format.duration) * 1000).toBeGreaterThanOrEqual(timeline.totalDurationMs * 0.9);

    // A partial render in the continuous scroll framing: whole shots up to the first 10 s, shorter than the chapter.
    const part = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      {
        kind: "video_pages",
        chapterId,
        video: { height: 720, fps: 24, minHoldMs: 2000, framing: "scroll", maxDurationMs: 10_000 },
        acknowledgeIssues: true,
      },
      202,
    );
    const partDone = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: { id: string; status: string; failureReason: string | null; files: { assetId: string }[] }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === part.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "partial video export", timeoutMs: 240_000 },
    );
    expect(`${partDone.status}:${partDone.failureReason ?? ""}`).toBe("completed:");
    const partPath = `${process.env.TMPDIR ?? "/tmp"}/mf-video-part.mp4`;
    await Bun.write(
      partPath,
      new Uint8Array(await (await u.raw("GET", `/cdn/a/${partDone.files[0]!.assetId}`)).arrayBuffer()),
    );
    const partSec = Number(
      (
        JSON.parse(
          Bun.spawnSync([
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            partPath,
          ]).stdout.toString(),
        ) as { format: { duration: string } }
      ).format.duration,
    );
    expect(partSec).toBeGreaterThanOrEqual(10);
    expect(partSec).toBeLessThan(Number(info.format.duration));

    // Whole project: no chapterId renders every chapter into one film.
    const whole = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_pages", video: { height: 720, fps: 24, minHoldMs: 1000 }, acknowledgeIssues: true },
      202,
    );
    const wholeDone = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: { id: string; status: string; failureReason: string | null; files: { fileName: string }[] }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === whole.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "project video export", timeoutMs: 240_000 },
    );
    expect(`${wholeDone.status}:${wholeDone.failureReason ?? ""}`).toBe("completed:");
    expect(wholeDone.files[0]!.fileName).toContain("_project_");
    // A film spanning chapters also gets YouTube chapter timestamps, and the package bundles it all.
    const wholeFiles = await u.get<{ jobs: { id: string; files: { fileName: string; assetId: string }[] }[] }>(
      `/api/projects/${projectId}/exports`,
    );
    const stamps = wholeFiles.jobs
      .find((j) => j.id === whole.job.id)!
      .files.find((f) => f.fileName.endsWith(".chapters.txt"));
    if (stamps) {
      const text = await (await u.raw("GET", `/cdn/a/${stamps.assetId}`)).text();
      expect(text.startsWith("0:00 Chapter 1")).toBe(true);
    }
    await u.patch(`/api/projects/${projectId}`, {
      settings: {
        youtubePackage: { titles: ["T"], description: "D", tags: ["a"], pinnedComment: "Q?", thumbnailHeadlines: [] },
      },
    });
    const pk = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "youtube_package", acknowledgeIssues: true },
      202,
    );
    const pkDone = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: { id: string; status: string; failureReason: string | null; files: { assetId: string }[] }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === pk.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "youtube package", timeoutMs: 120_000 },
    );
    expect(`${pkDone.status}:${pkDone.failureReason ?? ""}`).toBe("completed:");
    const zipNames = new TextDecoder("latin1").decode(
      new Uint8Array(await (await u.raw("GET", `/cdn/a/${pkDone.files[0]!.assetId}`)).arrayBuffer()),
    );
    for (const f of ["description.txt", "titles.txt", "tags.txt", "pinned-comment.txt", "video/", ".mp4", ".srt"])
      expect(zipNames).toContain(f);

    // A page selection renders only those pages: shorter than the chapter, and still a valid film.
    const chapterPages = await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
    expect(chapterPages.pages.length).toBeGreaterThan(1);
    const picked = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      {
        kind: "video_pages",
        chapterId,
        pageIds: [chapterPages.pages[0]!.id],
        video: { height: 720, fps: 24, minHoldMs: 2000 },
        acknowledgeIssues: true,
      },
      202,
    );
    const pickedDone = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: { id: string; status: string; failureReason: string | null; files: { assetId: string }[] }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === picked.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "page-selection video export", timeoutMs: 240_000 },
    );
    expect(`${pickedDone.status}:${pickedDone.failureReason ?? ""}`).toBe("completed:");
    const pickedPath = `${process.env.TMPDIR ?? "/tmp"}/mf-video-picked.mp4`;
    await Bun.write(
      pickedPath,
      new Uint8Array(await (await u.raw("GET", `/cdn/a/${pickedDone.files[0]!.assetId}`)).arrayBuffer()),
    );
    const pickedInfo = JSON.parse(
      Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        pickedPath,
      ]).stdout.toString(),
    ) as { format: { duration: string } };
    expect(Number(pickedInfo.format.duration)).toBeLessThan(Number(info.format.duration));

    // Panel cut (Ken Burns) with an .srt alongside
    const pc = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      {
        kind: "video_panels",
        chapterId,
        video: { height: 720, fps: 24, minHoldMs: 1500, zoom: 0.06 },
        acknowledgeIssues: true,
      },
      202,
    );
    const pcDone = await waitFor(
      async () => {
        const l = await u.get<{
          jobs: {
            id: string;
            status: string;
            failureReason: string | null;
            files: { assetId: string; fileName: string; mimeType: string }[];
          }[];
        }>(`/api/projects/${projectId}/exports`);
        const j = l.jobs.find((x) => x.id === pc.job.id);
        return j && ["completed", "failed"].includes(j.status) ? j : null;
      },
      { label: "panel cut export", timeoutMs: 240_000 },
    );
    expect(`${pcDone.status}:${pcDone.failureReason ?? ""}`).toBe("completed:");
    const mp4 = pcDone.files.find((f) => f.mimeType === "video/mp4")!;
    const srt = pcDone.files.find((f) => f.fileName.endsWith(".srt"))!;
    expect(mp4.fileName).toContain("panel-cut_720p.mp4");
    const srtText = await (await u.raw("GET", `/cdn/a/${srt.assetId}`)).text();
    expect(srtText).toMatch(/^1\n00:00:\d\d,\d{3} --> 00:00:\d\d,\d{3}\n/);
    const pcPath = `${process.env.TMPDIR ?? "/tmp"}/mf-video-panels.mp4`;
    await Bun.write(pcPath, new Uint8Array(await (await u.raw("GET", `/cdn/a/${mp4.assetId}`)).arrayBuffer()));
    const pcProbe = JSON.parse(
      Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        pcPath,
      ]).stdout.toString(),
    ) as { streams: { codec_type: string; width?: number; height?: number }[] };
    expect(pcProbe.streams.find((x) => x.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });
    expect(pcProbe.streams.some((x) => x.codec_type === "audio")).toBe(true);
  }, 600_000);

  test("film project: shot list of full-frame 16:9 pages, locked format, Ken Burns export", async () => {
    const p = await u.post<{ project: { id: string; settings: { format: string; pageWidth: number } } }>(
      "/api/projects",
      { title: "Film", format: "film", story: { content: STORY, inputKind: "story" } },
      201,
    );
    expect(p.project.settings).toMatchObject({ format: "film", pageWidth: 1920 });
    const projectId = p.project.id;
    const story = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
    const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    expect((await waitJob(a.job.id)).status).toBe("completed");
    await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
    const chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!
      .id;
    const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202);
    expect((await waitJob(plan.job.id)).status).toBe("completed");
    const ch = await u.get<{ pages: { id: string; width: number; height: number; panelCount: number }[] }>(
      `/api/chapters/${chapterId}`,
    );
    expect(ch.pages.length).toBeGreaterThan(1);
    for (const pg of ch.pages) expect(pg).toMatchObject({ width: 1920, height: 1080, panelCount: 1 });
    const page = await u.get<{ panels: { frame: { x: number; y: number; width: number; height: number } }[] }>(
      `/api/pages/${ch.pages[0]!.id}`,
    );
    expect(page.panels[0]!.frame).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    // the format is locked once pages exist
    await u.patch(`/api/projects/${projectId}`, { settings: { format: "comic" } }, 409);

    const bulk = await u.post<{ batchId: string }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: true, confirm: true },
      202,
    );
    await waitFor(
      async () => {
        const r = await u.get<{ progress: { total: number; completed: number } }>(
          `/api/generations/batches/${bulk.batchId}`,
        );
        return r.progress.completed === r.progress.total ? r : null;
      },
      { label: "shots", timeoutMs: 90_000 },
    );
    const gens = await u.get<{ jobs: { kind: string; compiledPrompt?: string; id: string }[] }>(
      `/api/projects/${projectId}/generations`,
    );
    const shotJob = gens.jobs.find((j) => j.kind === "panel_generation")!;
    const detail = await u.get<{ job: { compiledPrompt: string } }>(`/api/generations/${shotJob.id}`);
    expect(detail.job.compiledPrompt.startsWith("Create one cinematic 16:9 film frame")).toBe(true);

    const n = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/narration/generate`, {}, 202);
    expect((await waitJob(n.job.id)).status).toBe("completed");
    await u.post(`/api/chapters/${chapterId}/narration/synthesize`, { onlyMissing: true }, 202);
    await waitFor(
      async () => {
        const r = await u.get<{ lines: { segments: { audio: unknown }[] }[] }>(`/api/chapters/${chapterId}/narration`);
        return r.lines.length && r.lines.every((l) => l.segments.every((s) => s.audio)) ? r : null;
      },
      { label: "tts", timeoutMs: 60_000 },
    );
    const ex = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_panels", chapterId, video: { height: 720, fps: 24, minHoldMs: 1000 }, acknowledgeIssues: true },
      202,
    );
    const done = await waitFor(
      async () => {
        const r = await u.get<{
          job: { status: string; failureReason: string | null; files: { assetId: string; mimeType: string }[] };
        }>(`/api/jobs/${ex.job.id}`);
        return ["completed", "failed"].includes(r.job.status) ? r.job : null;
      },
      { label: "film export", timeoutMs: 240_000 },
    );
    expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
    const mp4 = done.files.find((f) => f.mimeType === "video/mp4")!;
    const path = `${process.env.TMPDIR ?? "/tmp"}/mf-film.mp4`;
    await Bun.write(path, new Uint8Array(await (await u.raw("GET", `/cdn/a/${mp4.assetId}`)).arrayBuffer()));
    // the film decodes
    const frame = Bun.spawnSync([
      "ffmpeg",
      "-v",
      "error",
      "-i",
      path,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-c:v",
      "png",
      "-",
    ]);
    expect(frame.exitCode).toBe(0);
    const probe = JSON.parse(
      Bun.spawnSync([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height",
        "-of",
        "json",
        path,
      ]).stdout.toString(),
    ) as { streams: { codec_type: string; width?: number; height?: number }[] };
    expect(probe.streams.find((x) => x.codec_type === "video")).toMatchObject({ width: 1280, height: 720 });
  }, 600_000);

  test("shot settings: a disabled shot, a set move, a fade and a spanning line, with the preview timing the render", async () => {
    const { projectId, chapterId } = await narratedChapter("Shots");
    type Shot = {
      key: string;
      joinNext: boolean;
      fade: { in: boolean; out: boolean };
      motion: string | null;
      lines: {
        id: string;
        startOffsetMs: number;
        endOffsetMs: number;
        segments: { durationMs: number | null; pauseAfterMs: number }[];
      }[];
    };
    const preview = () =>
      u.get<{ disabledPanels: number; shots: Shot[] }>(`/api/video-preview?chapterId=${chapterId}&cut=panel`);
    const before = await preview();
    const panelIds = before.shots.map((s) => s.key);
    expect(panelIds.length).toBeGreaterThanOrEqual(4);
    // No neighbouring auto moves repeat.
    for (let i = 1; i < before.shots.length; i++) expect(before.shots[i]!.motion).not.toBe(before.shots[i - 1]!.motion);

    await u.patch(`/api/panels/${panelIds[1]}`, { video: { disabled: true } });
    await u.patch(`/api/panels/${panelIds[0]}`, { video: { motion: "pan-left" } });
    await u.patch(`/api/panels/${panelIds[2]}`, { video: { fade: "on" } });
    const spanning = before.shots[0]!.lines[0] ?? before.shots[2]!.lines[0];
    expect(spanning).toBeTruthy();
    // A span must end inside the line's chapter.
    await u.patch(
      `/api/narration-lines/${spanning!.id}`,
      { video: { untilPanelId: crypto.randomUUID(), startOffsetMs: 0, endOffsetMs: 0 } },
      400,
    );
    await u.patch(`/api/narration-lines/${spanning!.id}`, {
      video: { untilPanelId: panelIds[3], startOffsetMs: 400, endOffsetMs: 600 },
    });

    const after = await preview();
    expect(after.disabledPanels).toBe(1);
    expect(after.shots.map((s) => s.key)).not.toContain(panelIds[1]);
    expect(after.shots[0]!.motion).toBe("pan-left");
    const fadeAt = after.shots.findIndex((s) => s.key === panelIds[2]);
    expect(after.shots[fadeAt]!.fade.in).toBe(true);
    expect(after.shots[fadeAt - 1]!.fade.out).toBe(true);
    const from = after.shots.findIndex((s) => s.lines.some((l) => l.id === spanning!.id));
    const to = after.shots.findIndex((s) => s.key === panelIds[3]);
    expect(to).toBeGreaterThan(from);
    for (let i = from; i < to; i++) expect(after.shots[i]!.joinNext).toBe(true);
    expect(after.shots[to]!.joinNext).toBe(false);

    // The preview's timeline, from the same shared helpers, is the render's length.
    const fps = 24;
    const minHoldMs = 1500;
    const frames = previewFrames(after.shots, fps, minHoldMs);
    const out = await runExport(projectId, { kind: "video_panels", chapterId, video: { height: 720, fps, minHoldMs } });
    const mp4 = await probe(out.files.find((f) => f.mimeType === "video/mp4")!.assetId);
    expect(Math.abs(mp4.ms - (frames * 1000) / fps)).toBeLessThan(80 + 10 * after.shots.length);
  }, 600_000);

  test("branding: a logo watermark and intro and outro cards, in the preview and the render", async () => {
    const { projectId, chapterId } = await narratedChapter("Branded");
    // A solid red logo, twice as wide as tall.
    const png = await sharp({ create: { width: 200, height: 100, channels: 4, background: "#ff0000ff" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png)], "logo.png", { type: "image/png" }));
    const logo = await u.json<{ asset: { id: string } }>("POST", `/api/projects/${projectId}/video-logo`, form, 201);
    // Only this project's own images can be the watermark.
    await u.patch(
      `/api/projects/${projectId}`,
      { settings: { video: { fadeAtSceneBreaks: false, watermark: { assetId: crypto.randomUUID() } } } },
      400,
    );
    await u.patch(`/api/projects/${projectId}`, {
      settings: {
        video: {
          fadeAtSceneBreaks: false,
          watermark: { assetId: logo.asset.id, corner: "bottom-right", opacity: 1, size: 0.12 },
          intro: { title: "The Rooftop", subtitle: "Chapter one", durationMs: 2000 },
          outro: { title: "Thanks for watching", subtitle: "", durationMs: 1500 },
        },
      },
    });
    const card = await u.raw("GET", `/api/projects/${projectId}/video-card/intro.png?height=720`);
    expect(card.status).toBe(200);
    expect(await sharp(new Uint8Array(await card.arrayBuffer())).metadata()).toMatchObject({
      width: 1280,
      height: 720,
    });
    const preview = await u.get<{
      branding: { intro: { durationMs: number }; outro: { durationMs: number }; watermark: { width: number } };
      shots: PreviewTiming[];
    }>(`/api/video-preview?chapterId=${chapterId}&cut=panel`);
    expect(preview.branding.watermark.width).toBe(200);

    const fps = 24;
    const minHoldMs = 1500;
    const introFrames = cardFrames(2000, fps);
    const frames = introFrames + previewFrames(preview.shots, fps, minHoldMs) + cardFrames(1500, fps);
    const out = await runExport(projectId, { kind: "video_panels", chapterId, video: { height: 720, fps, minHoldMs } });
    const mp4 = await probe(out.files.find((f) => f.mimeType === "video/mp4")!.assetId);
    expect(Math.abs(mp4.ms - (frames * 1000) / fps)).toBeLessThan(80 + 10 * (preview.shots.length + 2));
    // Subtitles start after the intro.
    const srt = await (
      await u.raw("GET", `/cdn/a/${out.files.find((f) => f.fileName.endsWith(".srt"))!.assetId}`)
    ).text();
    const first = /(\d\d):(\d\d):(\d\d),(\d{3}) -->/.exec(srt)!;
    const firstMs = ((Number(first[1]) * 60 + Number(first[2])) * 60 + Number(first[3])) * 1000 + Number(first[4]);
    expect(firstMs).toBeGreaterThanOrEqual((introFrames * 1000) / fps - 1);
    // The logo is composited where watermarkBox puts it, on a card and on a shot.
    const box = watermarkBox(1280, 720, { width: 200, height: 100 }, "bottom-right", 0.12);
    for (const at of [1, introFrames / fps + 0.5]) {
      const raw = Bun.spawnSync([
        "ffmpeg",
        "-v",
        "error",
        "-ss",
        String(at),
        "-i",
        mp4.path,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ]).stdout;
      const i = ((box.y + box.h / 2) * 1280 + box.x + box.w / 2) * 3;
      expect(raw[i]!).toBeGreaterThan(180);
      expect(raw[i + 1]!).toBeLessThan(80);
    }
  }, 600_000);
  test("Shorts: an automatic pick, adjusted, rendered vertical from the existing art; a square panel cut", async () => {
    const { projectId, chapterId } = await narratedChapter("Shorts");
    type Pick = {
      minMs: number;
      maxMs: number;
      pickedMs: number;
      warning: string | null;
      shots: { id: string; holdMs: number; hasArt: boolean; picked: boolean; score: number }[];
    };
    const pick = await u.get<Pick>(`/api/projects/${projectId}/shorts?chapterId=${chapterId}&minHoldMs=1500`);
    // Three minutes by default: YouTube's Shorts limit.
    expect(pick.maxMs).toBe(180_000);
    expect(pick.warning).toBeNull();
    const auto = pick.shots.filter((s) => s.picked);
    expect(auto.length).toBeGreaterThan(0);
    expect(auto.every((s) => s.hasArt)).toBe(true);
    expect(auto.reduce((n, s) => n + s.holdMs, 0)).toBeLessThanOrEqual(180_000);
    // The user drops the first pick; the render follows story order whatever order the ids come in.
    const chosen = (auto.length > 1 ? auto.slice(1) : auto).map((s) => s.id).reverse();
    await u.post(`/api/projects/${projectId}/exports`, { kind: "video_shorts", chapterId }, 400);
    await u.post(
      `/api/projects/${projectId}/exports`,
      { kind: "video_shorts", panelIds: [crypto.randomUUID()], acknowledgeIssues: true },
      404,
    );

    const fps = 24;
    const minHoldMs = 1500;
    const preview = await u.get<{
      aspect: string;
      shots: (PreviewTiming & { key: string; panel: { fill: boolean } })[];
    }>(`/api/video-preview?panelIds=${chosen.join(",")}&aspect=9:16`);
    expect(preview.aspect).toBe("9:16");
    expect(preview.shots.map((s) => s.key)).toEqual(pick.shots.filter((s) => chosen.includes(s.id)).map((s) => s.id));
    expect(preview.shots.every((s) => s.panel.fill)).toBe(true);
    const out = await runExport(projectId, {
      kind: "video_shorts",
      chapterId,
      panelIds: chosen,
      video: { height: 720, fps, minHoldMs },
    });
    const mp4 = out.files.find((f) => f.mimeType === "video/mp4")!;
    expect(mp4.fileName).toContain("_shorts_9x16_720p.mp4");
    const short = await probe(mp4.assetId);
    expect({ width: short.width, height: short.height }).toEqual({ width: 720, height: 1280 });
    expect(short.ms).toBeLessThanOrEqual(180_000 + 200);
    const frames = previewFrames(preview.shots, fps, minHoldMs);
    expect(Math.abs(short.ms - (frames * 1000) / fps)).toBeLessThan(80 + 10 * preview.shots.length);

    // A longer cut than YouTube takes as a Short: allowed, with the warning, and the render keeps the chosen length.
    const art = pick.shots.filter((s) => s.hasArt).map((s) => s.id);
    const long = await u.get<Pick>(
      `/api/projects/${projectId}/shorts?chapterId=${chapterId}&minHoldMs=30000&lengthSeconds=600`,
    );
    expect(long.maxMs).toBe(600_000);
    expect(long.pickedMs).toBeGreaterThan(180_000);
    expect(long.warning).toContain("YouTube doesn't accept Shorts over 3 minutes");
    const queued = await u.post<{ job: { id: string }; warnings?: string[] }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_shorts", panelIds: art, video: { height: 720, fps: 12, minHoldMs: 30_000, shortsSeconds: 600 } },
      202,
    );
    expect(queued.warnings?.[0]).toContain("this will upload as a regular video");
    await u.post(`/api/exports/${queued.job.id}/cancel`);
    // Within the limit there is no warning.
    const ok = await u.post<{ job: { id: string }; warnings?: string[] }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_shorts", panelIds: art, video: { height: 720, fps: 12, minHoldMs: 30_000, shortsSeconds: 90 } },
      202,
    );
    expect(ok.warnings).toBeUndefined();
    await u.post(`/api/exports/${ok.job.id}/cancel`);
    // Captions: an unknown style is refused, and so is a narration language the render has no font for.
    await u.post(
      `/api/projects/${projectId}/exports`,
      { kind: "video_shorts", panelIds: art, video: { captions: "karaoke" } },
      422,
    );
    const fontless = await u.raw("POST", `/api/projects/${projectId}/exports`, {
      kind: "video_shorts",
      panelIds: art,
      language: "ja",
      video: { captions: "bottom" },
    });
    expect(fontless.status).toBe(400);
    expect(await fontless.text()).toContain("no font for its script");
    // Off is always fine in that language, and other kinds ignore the option.
    const offJa = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_shorts", panelIds: art, language: "ja", video: { captions: "off" } },
      202,
    );
    await u.post(`/api/exports/${offJa.job.id}/cancel`);
    const panelsCut = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      {
        kind: "video_panels",
        chapterId,
        video: { captions: "center", maxDurationMs: 10_000 },
        acknowledgeIssues: true,
      },
      202,
    );
    await u.post(`/api/exports/${panelsCut.job.id}/cancel`);
    // A repurposing plan keeps each item's captions; a wrong value is refused.
    const item = { id: "short-1", kind: "short", label: "Short 1", panelIds: art.slice(0, 2), captions: "two_line" };
    await u.patch(`/api/projects/${projectId}`, { settings: { repurpose: { items: [item] } } });
    const plan = await u.get<{ items: { captions?: string }[] }>(`/api/projects/${projectId}/repurpose`);
    expect(plan.items[0]!.captions).toBe("two_line");
    await u.patch(
      `/api/projects/${projectId}`,
      { settings: { repurpose: { items: [{ ...item, captions: "huge" }] } } },
      422,
    );
    // The render honours the chosen length, whatever it is: 95 s of 30 s shots ends before the fourth, at 90 s.
    // Captions drawn into the picture re-encode the joined film without changing its length.
    const capped = await runExport(projectId, {
      kind: "video_shorts",
      panelIds: art,
      video: { height: 720, fps: 12, minHoldMs: 30_000, shortsSeconds: 95, captions: "bottom" },
    });
    const cappedMs = (await probe(capped.files.find((f) => f.mimeType === "video/mp4")!.assetId)).ms;
    expect(Math.abs(cappedMs - Math.min(3, art.length) * 30_000)).toBeLessThan(200);

    // Any video can be square or vertical: a square panel cut of the chapter.
    const sq = await runExport(projectId, {
      kind: "video_panels",
      chapterId,
      video: { height: 720, fps, minHoldMs, aspect: "1:1", maxDurationMs: 10_000 },
    });
    const square = await probe(sq.files.find((f) => f.mimeType === "video/mp4")!.assetId);
    expect({ width: square.width, height: square.height }).toEqual({ width: 720, height: 720 });
  }, 600_000);
  test("incremental rendering: one changed page re-encodes one section; staleness; update production; cleanup", async () => {
    const { projectId, chapterId } = await narratedChapter("Incremental");
    const pages = (await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`)).pages;
    expect(pages.length).toBeGreaterThan(1);
    const opts = { kind: "video_pages", video: { height: 720, fps: 24, minHoldMs: 1500 } };
    type Stage = { key: string; count: number };
    const stale = async () =>
      Object.fromEntries(
        (await u.get<{ stages: Stage[] }>(`/api/projects/${projectId}/staleness`)).stages.map((s) => [s.key, s.count]),
      );
    const sectionsOf = async (id: string) =>
      (await u.get<{ job: { result: { sections: { reused: number; encoded: number } } } }>(`/api/jobs/${id}`)).job
        .result.sections;
    const cached = async () => {
      const [r] = await h.deps.db.execute<{ n: number }>(
        sql`select count(*)::int as n from assets where project_id = ${projectId} and metadata ? 'renderSection'`,
      );
      return r!.n;
    };

    expect((await stale()).render).toBe(1); // no video yet
    const first = await runExport(projectId, opts);
    expect(await sectionsOf(first.id)).toEqual({ reused: 0, encoded: pages.length });
    expect(await cached()).toBe(pages.length);
    expect(await stale()).toMatchObject({ plan: 0, art: 0, narration: 0, audio: 0, render: 0 });
    const overview = await u.get<{ disk: { byCategory: { renderCache: number } } }>(`/api/projects/${projectId}`);
    expect(overview.disk.byCategory.renderCache).toBeGreaterThan(0);

    // Re-framing one panel changes one page's pixels: only that page's section is encoded again.
    const page = await u.get<{ panels: { id: string }[] }>(`/api/pages/${pages[1]!.id}`);
    await u.patch(`/api/panels/${page.panels[0]!.id}`, { imageTransform: { focalX: 0.3, focalY: 0.4, scale: 1.3 } });
    expect((await stale()).render).toBe(1);
    const second = await runExport(projectId, opts);
    expect(await sectionsOf(second.id)).toEqual({ reused: pages.length - 1, encoded: 1 });
    // The first render is superseded: its changed section is gone, the shared ones stay for the second.
    const firstJob = await u.get<{ job: { result: Record<string, unknown> } }>(`/api/jobs/${first.id}`);
    expect(firstJob.job.result.sectionKeys).toBeUndefined();
    expect(await cached()).toBe(pages.length);

    // "Update production" runs only what is stale: here just the video.
    await u.patch(`/api/panels/${page.panels[0]!.id}`, { imageTransform: { focalX: 0.5, focalY: 0.5, scale: 1 } });
    await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 50 } });
    const started = await u.post<{ run: { id: string; steps: { key: string }[] } }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, youtube: false },
      201,
    );
    expect(started.run.steps.map((s) => s.key)).toEqual(["render"]);
    const run = await waitFor(
      async () => {
        await advanceRun(h.deps, started.run.id);
        const { runs } = await u.get<{ runs: { id: string; status: string; reason: string | null }[] }>(
          `/api/projects/${projectId}/production-runs`,
        );
        const r = runs.find((x) => x.id === started.run.id)!;
        return ["completed", "failed"].includes(r.status) ? r : null;
      },
      { label: "update run", timeoutMs: 240_000 },
    );
    expect(`${run.status}:${run.reason ?? ""}`).toBe("completed:");
    expect((await stale()).render).toBe(0);
    await u.post(`/api/projects/${projectId}/production-runs`, { update: true, reviewGates: false }, 409);

    // Deleting the exports deletes the sections they claimed.
    await u.del(`/api/projects/${projectId}/exports`);
    expect(await cached()).toBe(0);
  }, 900_000);
  test("timing pass: real audio lengths, fixes previewed then applied, and the render runs as long as reported", async () => {
    const { projectId, chapterId } = await narratedChapter("Timing");
    // Shots of 1–2 s at most: every narrated shot runs long, so the pass has something to say.
    await u.patch(`/api/projects/${projectId}`, {
      settings: { targetRuntime: { minutes: 1, wordsPerMinute: 150, minShotSeconds: 1, maxShotSeconds: 2 } },
    });
    type Hold = { key: string; beforeMs: number; afterMs: number };
    type Report = {
      totalMs: number;
      targetMs: number | null;
      audio: { segments: number; voiced: number };
      shots: { key: string; panelId: string; holdMs: number; joinNext: boolean; lines: { id: string }[] }[];
      issues: { kind: string; key: string }[];
      fixes: {
        spread: { lineId: string; fromKey: string; untilPanelId: string; holds: Hold[]; deltaMs: number }[];
        holds: { panelId: string; key: string; holdMs: number; holds: Hold[]; deltaMs: number }[];
        trim: { lineId: string; words: number; budget: number }[];
      };
    };
    const report = (minHoldMs = 1500) => u.get<Report>(`/api/chapters/${chapterId}/timing?minHoldMs=${minHoldMs}`);
    const r1 = await report();
    expect(r1.audio.voiced).toBe(r1.audio.segments);
    expect(r1.targetMs).toBe(60_000);
    expect(r1.issues.some((i) => i.kind === "long" || i.kind === "still")).toBe(true);
    const projectView = await u.get<{ chapters: { id: string; totalMs: number }[] }>(
      `/api/projects/${projectId}/timing?minHoldMs=1500`,
    );
    expect(projectView.chapters.find((c) => c.id === chapterId)!.totalMs).toBe(r1.totalMs);

    // (a) Spread the first long line over the next shot(s) of its scene, then the report is what the fix promised.
    const spread = r1.fixes.spread[0]!;
    expect(spread).toBeTruthy();
    await u.post(`/api/chapters/${chapterId}/timing/apply`, {
      spread: { lineId: spread.lineId, untilPanelId: spread.untilPanelId },
    });
    const r2 = await report();
    expect(r2.shots.find((s) => s.key === spread.fromKey)!.joinNext).toBe(true);
    for (const h of spread.holds) expect(r2.shots.find((s) => s.key === h.key)!.holdMs).toBe(h.afterMs);
    expect(Math.abs(r2.totalMs - (r1.totalMs + spread.deltaMs))).toBeLessThanOrEqual(1);

    // (b) A high export minimum pads short shots; a shot's own hold takes it back, within the settings.
    const padded = await report(12_000);
    const hold = padded.fixes.holds[0]!;
    // Never below its narration: the hold the narration needs, not the 12 s minimum.
    expect(hold.holdMs).toBeLessThan(12_000);
    await u.post(`/api/chapters/${chapterId}/timing/apply`, { hold: { panelId: hold.panelId, holdMs: hold.holdMs } });
    const r3 = await report(12_000);
    expect(Math.abs(r3.totalMs - (padded.totalMs + hold.deltaMs))).toBeLessThanOrEqual(1);
    // The render holds exactly what the report says (frame-exact holds, real ffmpeg duration).
    const out = await runExport(projectId, {
      kind: "video_panels",
      chapterId,
      video: { height: 720, fps: 30, minHoldMs: 12_000 },
    });
    const mp4 = await probe(out.files.find((f) => f.mimeType === "video/mp4")!.assetId);
    expect(Math.abs(mp4.ms - r3.totalMs)).toBeLessThan(80 + 10 * r3.shots.length);

    // (c) Rewrite one line to a longer budget: proposed as a diff, applied to that line only, then only it re-voiced.
    const target = r3.shots.flatMap((s) => s.lines)[0]!;
    type Narr = {
      lines: { id: string; text: string; segments: { id: string; activeAudioAssetId: string | null }[] }[];
    };
    const before = await u.get<Narr>(`/api/chapters/${chapterId}/narration`);
    const others = before.lines.filter((l) => l.id !== target.id).flatMap((l) => l.segments);
    const job = await u.post<{ job: { id: string } }>(
      `/api/chapters/${chapterId}/narration/retime`,
      { lines: [{ lineId: target.id, words: 40 }] },
      202,
    );
    const done = await waitJob(job.job.id);
    expect(done.status).toBe("completed");
    const { job: finished } = await u.get<{
      job: { result: { lines: { lineId: string; text: string; after: string; afterWords: number }[] } };
    }>(`/api/generations/${job.job.id}`);
    const proposal = finished.result.lines[0]!;
    expect(proposal.lineId).toBe(target.id);
    expect(proposal.afterWords).toBe(40);
    // Nothing changed before applying.
    expect(
      (await u.get<Narr>(`/api/chapters/${chapterId}/narration`)).lines.find((l) => l.id === target.id)!.text,
    ).toBe(proposal.text);
    const applied = await u.post<{ applied: { lineId: string }[] }>(
      `/api/chapters/${chapterId}/narration/retime/${job.job.id}/apply`,
      { lineIds: [target.id] },
    );
    expect(applied.applied.map((a) => a.lineId)).toEqual([target.id]);
    await u.post(`/api/chapters/${chapterId}/narration/synthesize`, { lineIds: [target.id] }, 202);
    const after = await waitFor(
      async () => {
        const n = await u.get<Narr>(`/api/chapters/${chapterId}/narration`);
        return n.lines.every((l) => l.segments.every((s) => s.activeAudioAssetId)) ? n : null;
      },
      { label: "re-voiced line", timeoutMs: 60_000 },
    );
    expect(after.lines.find((l) => l.id === target.id)!.text).toBe(proposal.after);
    // Every other segment kept its audio: only the rewritten line was voiced again.
    const kept = new Map(after.lines.flatMap((l) => l.segments).map((s) => [s.id, s.activeAudioAssetId]));
    for (const s of others) expect(kept.get(s.id)).toBe(s.activeAudioAssetId);
  }, 600_000);
  test("repurposing: a reviewed plan, social copy, a trailer, a carousel and a quote image", async () => {
    const { projectId } = await narratedChapter("Repurpose");
    type Item = {
      id: string;
      kind: string;
      label: string;
      panelIds: string[];
      lengthSeconds?: number;
      aspect?: string;
      text: string;
      title: string;
      caption: string;
    };
    type Plan = {
      items: Item[];
      suggestion: Item[];
      candidates: { id: string; hasArt: boolean; holdMs: number; quotes: string[] }[];
    };
    const plan = await u.get<Plan>(`/api/projects/${projectId}/repurpose?shorts=2&minHoldMs=1500`);
    expect(plan.items).toEqual([]);
    const art = new Set(plan.candidates.filter((c) => c.hasArt).map((c) => c.id));
    expect(art.size).toBeGreaterThan(0);
    const shorts = plan.suggestion.filter((i) => i.kind === "short");
    expect(shorts.length).toBeGreaterThan(0);
    // Shorts of one plan never share a shot, and everything is picked from panels with art.
    const shortIds = shorts.flatMap((s) => s.panelIds);
    expect(new Set(shortIds).size).toBe(shortIds.length);
    expect(plan.suggestion.every((i) => i.panelIds.every((id) => art.has(id)))).toBe(true);
    const trailer = plan.suggestion.find((i) => i.kind === "trailer")!;
    expect(trailer.lengthSeconds).toBe(90);
    expect(trailer.aspect).toBe("16:9");
    expect(plan.suggestion.find((i) => i.kind === "teaser")!.lengthSeconds).toBe(30);
    const carousel = plan.suggestion.find((i) => i.kind === "carousel")!;
    expect(carousel.panelIds.length).toBe(Math.min(10, art.size));

    // The review step: the plan is edited (a quote written by hand, the carousel square) and saved.
    const first = [...art][0]!;
    const items: Item[] = [
      ...plan.suggestion.filter((i) => i.kind !== "quote"),
      {
        id: "quote-1",
        kind: "quote",
        label: "Quote",
        panelIds: [first],
        aspect: "4:5",
        text: "Who's there?",
        title: "",
        caption: "",
      },
    ].map((i) => (i.kind === "carousel" ? { ...i, aspect: "1:1" } : i));
    await u.patch(`/api/projects/${projectId}`, { settings: { repurpose: { items } } });
    // Social copy: a text job writes a title and caption into each saved item.
    const copy = await u.post<{ job: { id: string } }>(`/api/projects/${projectId}/repurpose/copy`, {}, 202);
    expect((await waitJob(copy.job.id)).status).toBe("completed");
    const saved = (await u.get<Plan>(`/api/projects/${projectId}/repurpose`)).items;
    expect(saved.map((i) => i.id)).toEqual(items.map((i) => i.id));
    expect(saved.every((i) => i.title.startsWith("Mock title:") && i.caption.length > 0)).toBe(true);
    expect(saved.find((i) => i.id === "quote-1")!.text).toBe("Who's there?");

    // The trailer renders as a Shorts cut named after it, landscape, within its length, with its caption.
    const t = saved.find((i) => i.kind === "trailer")!;
    const film = await runExport(projectId, {
      kind: "video_shorts",
      panelIds: t.panelIds,
      label: t.label,
      social: { title: t.title, caption: t.caption },
      video: { height: 720, fps: 12, shortsSeconds: t.lengthSeconds, aspect: t.aspect },
    });
    const mp4 = film.files.find((f) => f.mimeType === "video/mp4")!;
    expect(mp4.fileName).toContain("_trailer_720p.mp4");
    const m = await probe(mp4.assetId);
    expect({ width: m.width, height: m.height }).toEqual({ width: 1280, height: 720 });
    expect(m.ms).toBeLessThanOrEqual(90_000 + 200);
    const txt = film.files.find((f) => f.fileName.endsWith("_caption.txt"))!;
    expect(await (await u.raw("GET", `/cdn/a/${txt.assetId}`)).text()).toContain(t.title);

    // The carousel: one square image per picked panel, cropped from its art, and the caption, zipped.
    const c = saved.find((i) => i.kind === "carousel")!;
    const zip = await runExport(projectId, {
      kind: "carousel",
      panelIds: c.panelIds,
      label: c.label,
      social: { title: c.title, caption: c.caption },
      still: { aspect: "1:1" },
    });
    const entries = unzipSync(
      new Uint8Array(await (await u.raw("GET", `/cdn/a/${zip.files[0]!.assetId}`)).arrayBuffer()),
    );
    const pngs = Object.keys(entries).filter((n) => n.endsWith(".png"));
    expect(pngs.length).toBe(c.panelIds.length);
    expect(Object.keys(entries).some((n) => n.endsWith("_caption.txt"))).toBe(true);
    const slide = await sharp(entries[pngs[0]!]!).metadata();
    expect({ width: slide.width, height: slide.height }).toEqual({ width: 1080, height: 1080 });

    // The quote image: 4:5, the panel with its line set on it.
    await u.post(`/api/projects/${projectId}/exports`, { kind: "quote_image", panelIds: [first] }, 400);
    const q = await runExport(projectId, {
      kind: "quote_image",
      panelIds: [first],
      still: { aspect: "4:5", text: "Who's there?" },
    });
    const png = q.files.find((f) => f.mimeType === "image/png")!;
    const meta = await sharp(
      new Uint8Array(await (await u.raw("GET", `/cdn/a/${png.assetId}`)).arrayBuffer()),
    ).metadata();
    expect({ width: meta.width, height: meta.height }).toEqual({ width: 1080, height: 1350 });
  }, 600_000);
});
