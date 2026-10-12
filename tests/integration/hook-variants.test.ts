import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// The renders need ffmpeg/ffprobe (present in the app image, not in the plain bun test image).
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let panelIds: string[];
const HOOK = crypto.randomUUID();
const TEXT = "Nobody climbs this roof at night. Tonight, two people did.";

const waitJob = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "hooky", email: "ho@example.com", password: "hooky-pass-12" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Hooks", story: { content: STORY } }, 201)
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
  const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterId}/panels`);
  // The last two panels open the film.
  panelIds = panels.slice(-2).map((p) => p.id);
  await u.patch(`/api/projects/${projectId}`, {
    settings: {
      video: {
        fadeAtSceneBreaks: false,
        intro: { title: "Hooks", subtitle: "", durationMs: 1000 },
        hooks: [
          {
            id: HOOK,
            label: "Mystery",
            text: TEXT,
            panelIds,
            title: "Who was on the roof?",
            thumbnailHeadline: "WHO?",
          },
        ],
      },
    },
  });
}, 240_000);
afterAll(() => h?.stop());

test("the preview opens with the hook's panels and narration; the intro follows", async () => {
  type Shot = { key: string; joinNext: boolean; lines: { text: string }[] };
  const plain = await u.get<{ shots: Shot[]; openingShots: number }>(
    `/api/video-preview?chapterId=${chapterId}&cut=panel`,
  );
  expect(plain.openingShots).toBe(0);
  const p = await u.get<{ shots: Shot[]; openingShots: number }>(
    `/api/video-preview?chapterId=${chapterId}&cut=panel&hookId=${HOOK}`,
  );
  expect(p.openingShots).toBe(2);
  expect(p.shots.length).toBe(plain.shots.length + 2);
  expect(p.shots.slice(0, 2).map((s) => s.key)).toEqual(panelIds.map((id) => `opening-${id}`));
  expect(p.shots[0]!.joinNext).toBe(true);
  expect(p.shots[0]!.lines.map((l) => l.text)).toEqual([TEXT]);
  expect(p.shots[1]!.lines).toEqual([]);
  expect(p.shots.slice(2).map((s) => s.key)).toEqual(plain.shots.map((s) => s.key));
  await u.get(`/api/video-preview?chapterId=${chapterId}&cut=panel&hookId=${crypto.randomUUID()}`, 404);
});

test("an export picks a hook only for a panel cut, and only one of the project's", async () => {
  const ex = (video: Record<string, unknown>, kind = "video_panels") =>
    u.post(`/api/projects/${projectId}/exports`, { kind, chapterId, acknowledgeIssues: true, video }, 400);
  await ex({ hookId: HOOK }, "video_pages");
  await u.post(
    `/api/projects/${projectId}/exports`,
    { kind: "video_panels", chapterId, acknowledgeIssues: true, video: { hookId: crypto.randomUUID() } },
    404,
  );
});

test.skipIf(!hasFfmpeg)(
  "a hook variant renders in front of the same film, named for the hook",
  async () => {
    const render = async (video: Record<string, unknown>) => {
      const ex = await u.post<{ job: { id: string } }>(
        `/api/projects/${projectId}/exports`,
        { kind: "video_panels", chapterId, acknowledgeIssues: true, video: { height: 720, minHoldMs: 1000, ...video } },
        202,
      );
      return waitFor(
        async () => {
          const r = await u.get<{
            job: {
              status: string;
              result: {
                hook?: { label: string; title: string; thumbnailHeadline: string };
                sections?: { reused: number; encoded: number };
              } | null;
              files: { assetId: string; fileName: string; mimeType: string; durationMs?: number }[];
            };
          }>(`/api/jobs/${ex.job.id}`);
          return ["completed", "failed"].includes(r.job.status) ? r.job : null;
        },
        { label: "export", timeoutMs: 240_000 },
      );
    };
    const plain = await render({});
    const hooked = await render({ hookId: HOOK });
    expect(hooked.status).toBe("completed");
    expect(hooked.result?.hook).toMatchObject({
      label: "Mystery",
      title: "Who was on the roof?",
      thumbnailHeadline: "WHO?",
    });
    // Cheap: only the opening's two shots are encoded; the intro card and the film's shots are reused.
    expect(hooked.result?.sections?.encoded).toBe(2);
    const mp4 = hooked.files.find((f) => f.mimeType === "video/mp4")!;
    expect(mp4.fileName).toContain("_hook-mystery");
    const seconds = async (assetId: string) => {
      const path = `${process.env.TMPDIR ?? "/tmp"}/mf-hook-${assetId}.mp4`;
      await Bun.write(path, new Uint8Array(await (await u.raw("GET", `/cdn/a/${assetId}`)).arrayBuffer()));
      return Number(
        Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
          .stdout.toString()
          .trim(),
      );
    };
    // The opening adds its own shots (at least two minimum holds) in front of the same film.
    const extra =
      (await seconds(mp4.assetId)) - (await seconds(plain.files.find((f) => f.mimeType === "video/mp4")!.assetId));
    expect(extra).toBeGreaterThan(1.9);
    // The hook's narration is the first subtitle.
    const srt = await (
      await u.raw("GET", `/cdn/a/${hooked.files.find((f) => f.fileName.endsWith(".srt"))!.assetId}`)
    ).text();
    expect(srt).toContain(TEXT);
    expect(srt.indexOf(TEXT)).toBeLessThan(40);
  },
  600_000,
);
