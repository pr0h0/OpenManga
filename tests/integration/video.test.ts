import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

describe.skipIf(!hasFfmpeg)("video export (page cut)", () => {
  test("renders an MP4 whose length matches the narration, holding silent pages for the minimum", async () => {
    await u.post(
      "/api/auth/register",
      { username: "vid", email: "vid@example.com", password: "video password 1" },
      201,
    );
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
});
