import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// Clips (the free still-motion model) and renders need ffmpeg/ffprobe: present in the app image.

/** A mono 16-bit WAV of these samples. */
const wav = (pcm: Int16Array, rate: number) => {
  const out = new Uint8Array(44 + pcm.byteLength);
  const v = new DataView(out.buffer);
  out.set(new TextEncoder().encode("RIFF"), 0);
  v.setUint32(4, 36 + pcm.byteLength, true);
  out.set(new TextEncoder().encode("WAVEfmt "), 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  out.set(new TextEncoder().encode("data"), 36);
  v.setUint32(40, pcm.byteLength, true);
  out.set(new Uint8Array(pcm.buffer), 44);
  return out;
};
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

const STORY = `Chapter 1: Morning

Mina opened the window and the city lit up below her. She smiled at the new lamp on her desk.
"Finally," Mina said. The lamp glowed warm as the sun came up.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let panelIds: string[];

type Job = { id: string; status: string; result: Record<string, unknown> | null; failureReason: string | null };
const waitJob = (id: string, timeoutMs = 90_000) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: Job }>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs },
  );

type Clips = {
  activeAssetId: string | null;
  clips: { assetId: string; model: string; durationMs: number; provider: string }[];
  prompt: string;
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "clipper", email: "cl@example.com", password: "clipper-pass-1" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Clips", format: "film", story: { content: STORY, inputKind: "story" } },
      201,
    )
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await waitJob(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  await waitJob((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202)).job.id);
  const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterId}/panels`);
  panelIds = panels.map((p) => p.id);
}, 240_000);
afterAll(() => h?.stop());

test("the model list: the free model for everyone, paid ones only with a key for their provider", async () => {
  const r = await u.get<{ models: { id: string; provider: string; usable: boolean }[]; credentials: unknown[] }>(
    "/api/video-models",
  );
  expect(r.models.find((m) => m.id === "still-motion")).toMatchObject({ provider: "local", usable: true });
  expect(r.models.filter((m) => m.provider === "fal").every((m) => !m.usable)).toBe(true);
  expect(r.credentials).toEqual([]);
});

test("a shot is animated only once it is drawn; prices are estimated before anything is queued", async () => {
  const id = panelIds[0]!;
  await u.post(`/api/panels/${id}/clips`, { runs: [{ credentialId: null }] }, 400);
  // A paid model needs a key of its provider.
  await u.post(
    `/api/panels/${id}/clips`,
    { runs: [{ credentialId: null, model: "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video" }] },
    400,
  );
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
  const free = await u.post<{ estimate: { usd: number; runs: { seconds: number }[] } }>(
    `/api/panels/${id}/clips`,
    { runs: [{ credentialId: null }], seconds: 4, dryRun: true },
  );
  expect(free.estimate).toMatchObject({ usd: 0, runs: [{ seconds: 4 }] });
  // With a fal key (stored unverified in mock mode), the same shot is priced per second at the model's rate.
  const cred = await u.post<{ credential: { id: string } }>(
    "/api/ai/credentials",
    { kind: "fal", label: "fal", apiKey: "fal-test-key-123456" },
    201,
  );
  const paid = await u.post<{ estimate: { usd: number; runs: { seconds: number; resolution: string }[] } }>(
    `/api/panels/${id}/clips`,
    {
      runs: [{ credentialId: cred.credential.id, model: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video" }],
      seconds: 4,
      resolution: "720p",
      dryRun: true,
    },
  );
  // Kling 2.5 Turbo Pro offers 5 or 10 s at 1080p, $0.07/s.
  expect(paid.estimate.runs[0]).toMatchObject({ seconds: 5, resolution: "1080p" });
  expect(paid.estimate.usd).toBeCloseTo(0.35, 4);
  const models = await u.get<{ models: { id: string; usable: boolean }[] }>("/api/video-models");
  expect(models.models.find((m) => m.id.startsWith("fal-ai/kling"))?.usable).toBe(true);
});

test.skipIf(!hasFfmpeg)(
  "a clip is made, becomes the shot's, can be swapped, compared and taken back",
  async () => {
    const id = panelIds[0]!;
    const r = await u.post<{ jobs: { id: string }[]; compareId: string | null }>(
      `/api/panels/${id}/clips`,
      { runs: [{ credentialId: null }], seconds: 3, resolution: "480p", prompt: "She turns to the window" },
      202,
    );
    expect(r.compareId).toBeNull();
    const job = await waitJob(r.jobs[0]!.id);
    expect(job.status).toBe("completed");
    let clips = await u.get<Clips>(`/api/panels/${id}/clips`);
    expect(clips.clips).toHaveLength(1);
    expect(clips.activeAssetId).toBe(clips.clips[0]!.assetId);
    expect(clips.clips[0]).toMatchObject({ provider: "local", model: "still-motion" });
    expect(clips.clips[0]!.durationMs).toBeGreaterThan(2500);
    expect(clips.prompt).toContain("ACTION");
    const detail = await u.get<{ job: { compiledPrompt: string } }>(`/api/generations/${job.id}`);
    expect(detail.job.compiledPrompt).toContain("She turns to the window");

    // Two runs compare models: both kept as versions, the shot keeps playing its clip.
    const cmp = await u.post<{ jobs: { id: string }[]; compareId: string | null }>(
      `/api/panels/${id}/clips`,
      { runs: [{ credentialId: null }, { credentialId: null }], seconds: 3, resolution: "480p" },
      202,
    );
    expect(cmp.compareId).toBeTruthy();
    for (const j of cmp.jobs) expect((await waitJob(j.id)).status).toBe("completed");
    const first = clips.activeAssetId;
    clips = await u.get<Clips>(`/api/panels/${id}/clips`);
    expect(clips.clips).toHaveLength(3);
    expect(clips.activeAssetId).toBe(first);

    const other = clips.clips.find((c) => c.assetId !== first)!.assetId;
    await u.post(`/api/panels/${id}/clips/use`, { assetId: other });
    expect((await u.get<Clips>(`/api/panels/${id}/clips`)).activeAssetId).toBe(other);
    // Another panel's clip, or an image, is refused.
    await u.post(`/api/panels/${panelIds[1]}/clips/use`, { assetId: other }, 404);
    // A panel patch that only moves the camera keeps the clip.
    await u.patch(`/api/panels/${id}`, { video: { motion: "pan-left" } });
    expect((await u.get<Clips>(`/api/panels/${id}/clips`)).activeAssetId).toBe(other);
    // Deleting the clip a shot plays sends it back to its still.
    await u.del(`/api/clips/${other}`, 204);
    clips = await u.get<Clips>(`/api/panels/${id}/clips`);
    expect(clips.activeAssetId).toBeNull();
    expect(clips.clips).toHaveLength(2);
    await u.post(`/api/panels/${id}/clips/use`, { assetId: first });
  },
  180_000,
);

test.skipIf(!hasFfmpeg)(
  "a chapter is animated in one go, then renders with its clips, text on screen and a ducked music bed",
  async () => {
    const est = await u.post<{ estimate: { shots: number; usd: number } }>(`/api/chapters/${chapterId}/clips`, {
      ai: { credentialId: null },
      seconds: 3,
      resolution: "480p",
      dryRun: true,
    });
    // The first shot already plays a clip.
    expect(est.estimate).toMatchObject({ shots: panelIds.length - 1, usd: 0 });
    const run = await u.post<{ jobs: { id: string }[] }>(
      `/api/chapters/${chapterId}/clips`,
      { ai: { credentialId: null }, seconds: 3, resolution: "480p" },
      202,
    );
    for (const j of run.jobs) expect((await waitJob(j.id)).status).toBe("completed");

    await u.patch(`/api/panels/${panelIds.at(-1)}`, {
      video: { onScreenText: { text: "ORDER TODAY", position: "bottom", style: "cta" } },
    });
    // Two seconds of a 220 Hz tone as the music bed.
    const pcm = new Int16Array(24_000 * 2).map((_, i) => Math.round(Math.sin((i / 24_000) * 2 * Math.PI * 220) * 8000));
    const form = new FormData();
    form.set("file", new File([wav(pcm, 24_000)], "bed.wav", { type: "audio/wav" }));
    const music = await u.json<{ asset: { id: string } }>("POST", `/api/projects/${projectId}/video-music`, form, 201);
    const bad = new FormData();
    bad.set("file", new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])], "x.mp3"));
    await u.json("POST", `/api/projects/${projectId}/video-music`, bad, 415);
    await u.patch(`/api/projects/${projectId}`, {
      settings: { video: { music: { assetId: music.asset.id, volume: 0.3, duck: true } } },
    });

    const ex = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_panels", chapterId, acknowledgeIssues: true, video: { height: 720, minHoldMs: 1000 } },
      202,
    );
    const done = await waitFor(
      async () => {
        const r = await u.get<{
          job: {
            status: string;
            failureReason: string | null;
            result: { clipShots?: number; onScreenTexts?: number; music?: unknown } | null;
          };
        }>(`/api/jobs/${ex.job.id}`);
        return ["completed", "failed"].includes(r.job.status) ? r.job : null;
      },
      { label: "render", timeoutMs: 300_000 },
    );
    expect(done.failureReason).toBeNull();
    expect(done.status).toBe("completed");
    expect(done.result?.clipShots).toBe(panelIds.length);
    expect(done.result?.onScreenTexts).toBe(1);
    expect(done.result?.music).toMatchObject({ volume: 0.3, duck: true });
  },
  420_000,
);

test("an ad's script is written from its brief and saved as the story", async () => {
  const brief = {
    product: "Glowtide desk lamp",
    audience: "people working late",
    callToAction: "Order today",
    lengthSeconds: 30,
  };
  await u.post(`/api/projects/${projectId}/ad-script`, { brief: { product: "" } }, 422);
  const r = await u.post<{ job: { id: string } }>(`/api/projects/${projectId}/ad-script`, { brief }, 202);
  const job = await waitJob(r.job.id);
  expect(job.status).toBe("completed");
  const story = await u.get<{ latest: { content: string; inputKind: string } }>(`/api/projects/${projectId}/story`);
  expect(story.latest.content).toContain("Glowtide desk lamp");
  expect(story.latest.content).toContain("VOICEOVER");
  const p = await u.get<{ project: { settings: { ad?: { product: string; lengthSeconds: number } } } }>(
    `/api/projects/${projectId}`,
  );
  expect(p.project.settings.ad).toMatchObject({ product: brief.product, lengthSeconds: 30 });
});
