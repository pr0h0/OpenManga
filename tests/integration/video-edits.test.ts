import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, narrationLines, narrationSegments, panels, projects } from "@openmanga/db";
import { cardFrames, shotGroups, timeGroup } from "@openmanga/domain";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// The render check needs ffmpeg/ffprobe (present in the app image, not in the plain bun test image).
const hasFfmpeg = Boolean(Bun.which("ffmpeg") && Bun.which("ffprobe"));

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;

type Job = { status: string; failureReason: string | null; result: Record<string, unknown> | null };
const waitJob = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: Job }>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );
type Edit = { op: { op: string } & Record<string, unknown>; label: string; effect: string; changes: number };

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "cutter", email: "cu@example.com", password: "cutter-pass-12" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Cuts", story: { content: STORY } }, 201)
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
  expect(
    (await waitJob((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202)).job.id)).status,
  ).toBe("completed");
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
}, 240_000);
afterAll(() => h?.stop());

test("an instruction becomes reviewed edits; the ticked and changed ones are applied", async () => {
  await u.post(`/api/projects/${projectId}/video-edits`, { instruction: "" }, 422);
  const p = await u.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/video-edits`,
    { instruction: "Make chapter 1 faster, add a title card before chapter 1, fade at scene breaks, skip a shot" },
    202,
  );
  const job = await waitJob(p.job.id);
  expect(job.status).toBe("completed");
  const edits = job.result!.edits as Edit[];
  expect(edits.map((e) => e.op.op)).toEqual(["pauses", "card", "scene_fades", "shot"]);
  expect(edits[0]!.label).toBe("Chapter 1: pauses at most 200 ms");
  expect(edits[0]!.changes).toBeGreaterThan(0);
  expect(edits[0]!.effect).toContain("shorter");
  expect(job.result!.dropped).toEqual([]);
  // Nothing changed yet.
  const segs = () =>
    h.deps.db
      .select({ ms: narrationSegments.pauseAfterMs })
      .from(narrationSegments)
      .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
      .where(eq(narrationLines.chapterId, chapterId));
  expect((await segs()).some((s) => s.ms > 200)).toBe(true);

  // Keep the pauses and the card (retitled), the fades; leave the shot out.
  const card = edits[1]!.op as { op: "card"; card: { title: string } };
  const ops = [edits[0]!.op, { ...card, card: { ...card.card, title: "Part One" } }, edits[2]!.op];
  // Another project's job is not this one's.
  const other = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Other" }, 201)).project.id;
  await u.post(`/api/projects/${other}/video-edits/${p.job.id}/apply`, { ops }, 404);
  const r = await u.post<{ applied: { label: string; changes: number }[] }>(
    `/api/projects/${projectId}/video-edits/${p.job.id}/apply`,
    { ops },
  );
  expect(r.applied.map((a) => a.label)).toEqual([
    "Chapter 1: pauses at most 200 ms",
    "Chapter 1 title card: “Part One”",
    "Fade to black at scene breaks: on",
  ]);
  expect((await segs()).every((s) => s.ms <= 200)).toBe(true);
  const [proj] = await h.deps.db.select().from(projects).where(eq(projects.id, projectId));
  expect(proj!.settings.video?.chapterCards).toEqual([
    { chapterId, title: "Part One", subtitle: "", durationMs: 2000 },
  ]);
  expect(proj!.settings.video?.fadeAtSceneBreaks).toBe(true);
  const pns = await h.deps.db.select({ video: panels.video }).from(panels).where(eq(panels.projectId, projectId));
  expect(pns.some((x) => x.video?.disabled)).toBe(false);
  // A chapter outside the project is refused.
  await u.post(
    `/api/projects/${projectId}/video-edits/${p.job.id}/apply`,
    { ops: [{ op: "holds", chapterId: crypto.randomUUID(), holdMs: 2000 }] },
    400,
  );

  // The card is drawn and in the preview; a chapter not in a reader link's scope is not.
  expect((await u.raw("GET", `/api/projects/${projectId}/video-card/chapter-${chapterId}.png?height=360`)).status).toBe(
    200,
  );
  expect(
    (await u.raw("GET", `/api/projects/${projectId}/video-card/chapter-${crypto.randomUUID()}.png?height=360`)).status,
  ).toBe(404);
  const preview = await u.get<{ branding: { chapters: { chapterId: string; title: string }[] } }>(
    `/api/video-preview?chapterId=${chapterId}&cut=panel`,
  );
  expect(preview.branding.chapters.map((c) => c.title)).toEqual(["Part One"]);
}, 120_000);

test.skipIf(!hasFfmpeg)(
  "the render plays the chapter card before the chapter's first shot",
  async () => {
    type Shot = {
      joinNext: boolean;
      lines: {
        startOffsetMs: number;
        endOffsetMs: number;
        segments: { durationMs: number | null; pauseAfterMs: number }[];
      }[];
    };
    const fps = 24;
    const minHoldMs = 1500;
    const preview = await u.get<{ shots: Shot[] }>(`/api/video-preview?chapterId=${chapterId}&cut=panel`);
    let frames = cardFrames(2000, fps);
    for (const g of shotGroups(preview.shots.map((s) => s.joinNext))) {
      const members = preview.shots.slice(g.first, g.last + 1);
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
    const ex = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_panels", chapterId, acknowledgeIssues: true, video: { height: 720, fps, minHoldMs } },
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
    const path = `${process.env.TMPDIR ?? "/tmp"}/mf-edit-${mp4.assetId}.mp4`;
    await Bun.write(path, new Uint8Array(await (await u.raw("GET", `/cdn/a/${mp4.assetId}`)).arrayBuffer()));
    const sec = Number(
      Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path])
        .stdout.toString()
        .trim(),
    );
    expect(Math.abs(sec * 1000 - (frames * 1000) / fps)).toBeLessThan(80 + 10 * (preview.shots.length + 1));
  },
  300_000,
);

test("a duplicate's chapter cards follow its own chapters", async () => {
  const copy = await u.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
  const [c] = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${copy.project.id}/chapters`)).chapters;
  const [proj] = await h.deps.db.select().from(projects).where(eq(projects.id, copy.project.id));
  expect(proj!.settings.video?.chapterCards?.map((x) => [x.chapterId, x.title])).toEqual([[c!.id, "Part One"]]);
}, 60_000);
