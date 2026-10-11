import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// The render check needs ffmpeg/ffprobe (present in the app image, not in the plain bun test image).
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;

type Settings = {
  format: string;
  filmFrame?: string;
  pageWidth: number;
  pageHeight: number;
  video?: { output?: { aspect: string } };
};
const settingsOf = async (id: string) =>
  (await u.get<{ project: { settings: Settings } }>(`/api/projects/${id}`)).project.settings;
const waitJob = (id: string) =>
  waitFor(
    async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, id));
      return j && ["completed", "failed"].includes(j.status) ? j : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "tall", email: "ta@example.com", password: "tall-pass-1234" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Tall", format: "film", filmFrame: "9:16", story: { content: STORY } },
      201,
    )
  ).project.id;
}, 60_000);
afterAll(() => h?.stop());

test("a vertical film project is planned, prompted and sized at 9:16 from the start", async () => {
  expect(await settingsOf(projectId)).toMatchObject({
    format: "film",
    filmFrame: "9:16",
    pageWidth: 1080,
    pageHeight: 1920,
    video: { output: { aspect: "9:16" } },
  });
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const an = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await waitJob(an.job.id);
  await u.post(`/api/story-analyses/${an.analysis.id}/apply`, {});
  chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202);
  const done = await waitJob(plan.job.id);
  expect(done.status).toBe("completed");
  expect(done.templateName).toBe("vertical-shot-planning");
  const ch = await u.get<{ pages: { width: number; height: number }[] }>(`/api/chapters/${chapterId}`);
  expect(ch.pages.length).toBeGreaterThan(0);
  expect(ch.pages.every((p) => p.width === 1080 && p.height === 1920)).toBe(true);
  const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterId}/panels`);
  const pv = await u.get<{ compiledPrompt: string }>(`/api/panels/${panels[0]!.id}/prompt-preview`);
  expect(pv.compiledPrompt).toStartWith("Create one cinematic vertical 9:16 film frame");
  // The prompt lab offers the vertical planner's prompts.
  const lab = await u.get<{ templates: { name: string }[] }>(`/api/projects/${projectId}/prompt-lab`);
  expect(lab.templates.map((t) => t.name)).toContain("vertical-scene-shots");
  expect(lab.templates.map((t) => t.name)).not.toContain("scene-shots");
  // The frame is fixed once pages exist.
  await u.patch(`/api/projects/${projectId}`, { settings: { filmFrame: "16:9" } }, 409);
}, 120_000);

test("a film project's frame can change before it has pages; a widescreen film keeps 16:9", async () => {
  const id = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Wide", format: "film" }, 201))
    .project.id;
  expect(await settingsOf(id)).toMatchObject({ filmFrame: "16:9", pageWidth: 1920, pageHeight: 1080 });
  await u.patch(`/api/projects/${id}`, { settings: { filmFrame: "9:16" } });
  expect(await settingsOf(id)).toMatchObject({
    filmFrame: "9:16",
    pageWidth: 1080,
    pageHeight: 1920,
    video: { output: { aspect: "9:16" } },
  });
});

test.skipIf(!hasFfmpeg)(
  "the video renders vertical by default, from the art as drawn",
  async () => {
    const n = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/narration/generate`, {}, 202);
    await waitJob(n.job.id);
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
      { kind: "video_panels", chapterId, acknowledgeIssues: true, video: { height: 720, minHoldMs: 1000 } },
      202,
    );
    const done = await waitFor(
      async () => {
        const r = await u.get<{ job: { status: string; files: { assetId: string; mimeType: string }[] } }>(
          `/api/jobs/${ex.job.id}`,
        );
        return ["completed", "failed"].includes(r.job.status) ? r.job : null;
      },
      { label: "export", timeoutMs: 240_000 },
    );
    expect(done.status).toBe("completed");
    const mp4 = done.files.find((f) => f.mimeType === "video/mp4")!;
    const path = `${process.env.TMPDIR ?? "/tmp"}/mf-tall-${mp4.assetId}.mp4`;
    await Bun.write(path, new Uint8Array(await (await u.raw("GET", `/cdn/a/${mp4.assetId}`)).arrayBuffer()));
    const size = Bun.spawnSync([
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "csv=p=0",
      path,
    ])
      .stdout.toString()
      .trim();
    expect(size).toBe("720,1280");
  },
  300_000,
);
