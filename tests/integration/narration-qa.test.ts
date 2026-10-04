import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs, narrationSegments, sql } from "@openmanga/db";
import { pcmToWav } from "../../packages/audio/src/index.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let chapterId: string;

type Finding = { id: string; kind: string; status: string; lineIds: string[]; check: string; fixable: boolean };
type Findings = {
  findings: Finding[];
  counts: { byStatus: Record<string, number>; openByKind: Record<string, number> };
};
type Seg = { id: string; activeAudioAssetId: string | null; stale: boolean; audio: unknown };
type Doc = { lines: { id: string; text: string; segments: Seg[] }[] };

const job = async (id: string) => (await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
const finished = (id: string, status = "completed") =>
  waitFor(async () => ((await job(id)).status === status ? job(id) : null), { label: `job ${status}` });
const findings = (q = "") => alice.get<Findings>(`/api/projects/${projectId}/narration/findings${q}`);
const narration = () => alice.get<Doc>(`/api/chapters/${chapterId}/narration`);

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "editor", email: "qa@example.com", password: "qa-pass-1234" },
    201,
  );
  ({
    project: { id: projectId },
  } = await alice.post<{ project: { id: string } }>("/api/projects", { title: "QA" }, 201));
  ({
    chapter: { id: chapterId },
  } = await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201));
  for (const text of [
    "Tomas lit the lamp before the storm reached the harbour.",
    "Tomas lit the lamp before the storm reached the harbour!",
    "Ines watched from the jetty. [[mock:lint]]",
    "She thought about the light all evening. [[mock:lint]]",
  ])
    await alice.post(`/api/chapters/${chapterId}/narration/lines`, { text }, 201);
});
afterAll(() => h?.stop());

test("the deterministic checks store findings, and an ignored finding stays ignored on the next run", async () => {
  const r = await alice.post<{ rules: { found: number; introduced: number } }>(
    `/api/chapters/${chapterId}/narration/lint`,
    {},
  );
  expect(r.rules).toMatchObject({ found: 1, introduced: 1 });
  const dup = (await findings()).findings.find((f) => f.kind === "near_duplicate")!;
  expect(dup.check).toBe("rule");
  await alice.patch(`/api/narration-findings/${dup.id}`, { status: "ignored" });
  const again = await alice.post<{ rules: { remaining: number; introduced: number } }>(
    `/api/chapters/${chapterId}/narration/lint`,
    {},
  );
  expect(again.rules).toMatchObject({ remaining: 1, introduced: 0 });
  expect((await findings()).findings.find((f) => f.id === dup.id)?.status).toBe("ignored");
});

test("the semantic check, a fix of only the flagged lines, re-voicing only what changed, and a re-check", async () => {
  const lint = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapterId}/narration/lint`,
    { semantic: true },
    202,
  );
  await finished(lint.job.id);
  const ai = (await findings("?status=open")).findings.find((f) => f.check === "ai")!;
  expect(ai.kind).toBe("repeated_meaning");
  expect(ai.lineIds).toHaveLength(2);

  // Voice the chapter first, so the fix has audio to keep and audio to replace.
  await alice.post(`/api/chapters/${chapterId}/narration/synthesize`, {}, 202);
  await waitFor(async () => (await narration()).lines.every((l) => l.segments.every((s) => s.audio)), {
    label: "voiced",
  });
  const before = await narration();

  const fix = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapterId}/narration/fix`,
    { findingIds: [ai.id] },
    202,
  );
  const done = await finished(fix.job.id);
  const proposals = (done.result as { proposals: { lineId: string; before: string; after: string }[] }).proposals;
  // Only the flagged lines, shown as before and after; nothing is written yet.
  expect(proposals.map((p) => p.lineId).sort()).toEqual([...ai.lineIds].sort());
  expect(proposals.every((p) => p.before.includes("[[mock:lint]]") && !p.after.includes("[[mock:lint]]"))).toBe(true);
  expect((await narration()).lines.map((l) => l.text)).toEqual(before.lines.map((l) => l.text));

  const applied = await alice.post<{
    applied: string[];
    revoiced: number;
    rules: { found: number; introduced: number };
    recheckJob: { id: string } | null;
  }>(`/api/chapters/${chapterId}/narration/fix/apply`, { jobId: fix.job.id, recheck: true });
  expect(applied.applied.sort()).toEqual([...ai.lineIds].sort());
  expect(applied.revoiced).toBe(2);
  // The rule checks ran again at once: still only the ignored duplicate, nothing new.
  expect(applied.rules).toMatchObject({ found: 1, introduced: 0 });

  await waitFor(async () => (await narration()).lines.every((l) => l.segments.every((s) => s.audio && !s.stale)), {
    label: "re-voiced",
  });
  const after = await narration();
  for (const [i, line] of after.lines.entries()) {
    const was = before.lines[i]!.segments.map((s) => s.activeAudioAssetId);
    const now = line.segments.map((s) => s.activeAudioAssetId);
    // The untouched lines keep their takes; the rewritten ones have new ones.
    if (ai.lineIds.includes(line.id)) expect(now).not.toEqual(was);
    else expect(now).toEqual(was);
  }

  // The AI re-check compares with the findings before it: the fixed one is gone and nothing new came.
  const recheck = await finished(applied.recheckJob!.id);
  expect(recheck.result).toMatchObject({ found: 0, resolved: 1, introduced: 0 });
  expect((await findings()).findings.some((f) => f.id === ai.id)).toBe(false);

  // Applying the same proposal again changes nothing: the lines are no longer what it was written against.
  const twice = await alice.post<{ applied: string[]; skipped: string[] }>(
    `/api/chapters/${chapterId}/narration/fix/apply`,
    { jobId: fix.job.id, revoice: false },
  );
  expect(twice.applied).toEqual([]);
  expect(twice.skipped).toHaveLength(2);
});

test("the density view counts words per shot and the words a minute of the real audio", async () => {
  const d = await alice.get<{
    chapters: { id: string; words: number; audioMs: number | null; wordsPerMinute: number | null }[];
  }>(`/api/projects/${projectId}/narration/density?chapterId=${chapterId}`);
  const ch = d.chapters.find((c) => c.id === chapterId)!;
  expect(ch.words).toBeGreaterThan(20);
  expect(ch.audioMs).toBeGreaterThan(0);
  expect(ch.wordsPerMinute).toBeGreaterThan(0);
});

test("the audio check: a loudness report, a silent take found, and a new take that replaces a cached one", async () => {
  type Report = { chapters: { chapterId: string; segments: number; lufs: number; truePeakDb: number }[] };
  const check = async () => {
    const r = await alice.post<{ audioJob: { id: string } }>(
      `/api/chapters/${chapterId}/narration/lint`,
      { audio: true },
      202,
    );
    return (await finished(r.audioJob.id)).result as Report & { found: number; resolved: number };
  };
  const audioFindings = async () => (await findings("?status=open")).findings.filter((f) => f.check === "audio");

  const first = await check();
  expect(first.chapters).toHaveLength(1);
  // The fake voice is a steady tone: measurable loudness, no clipping, nothing to flag.
  expect(first.chapters[0]!.lufs).toBeGreaterThan(-40);
  expect(first.chapters[0]!.lufs).toBeLessThan(-10);
  expect(first.chapters[0]!.truePeakDb).toBeLessThan(0);
  expect(await audioFindings()).toEqual([]);
  const report = await alice.get<{ audio: { chapterId: string; lufs: number }[] }>(
    `/api/projects/${projectId}/narration/findings`,
  );
  expect(report.audio).toEqual([expect.objectContaining({ chapterId, lufs: first.chapters[0]!.lufs })]);

  // A silent take, cached as the newest audio for the same text, voice and speed.
  const line = (await narration()).lines[0]!;
  const seg = line.segments[0]!;
  const asset = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type: "audio",
    data: pcmToWav(new Uint8Array(24_000 * 2), 24_000),
    mimeType: "audio/wav",
    metadata: { trimmedSilenceMs: 0 },
  });
  await h.deps.db.execute(sql`insert into audio_assets
      (project_id, asset_id, segment_id, text_sha256, voice, speed, language, provider, sample_rate, duration_ms, format)
    select project_id, ${asset.id}, segment_id, text_sha256, voice, speed, language, provider, sample_rate, 1000, format
    from audio_assets where asset_id = ${seg.activeAudioAssetId}`);
  await h.deps.db
    .update(narrationSegments)
    .set({ activeAudioAssetId: asset.id })
    .where(eq(narrationSegments.id, seg.id));
  await check();
  const [silent] = await audioFindings();
  expect(silent).toMatchObject({ kind: "audio_silent", lineIds: [line.id], fixable: false });

  // A new take skips the cached silent one.
  await alice.post(
    `/api/chapters/${chapterId}/narration/synthesize`,
    { lineIds: [line.id], onlyMissing: false, newTake: true },
    202,
  );
  await waitFor(
    async () => {
      const s = (await narration()).lines[0]!.segments[0]!;
      return s.audio && s.activeAudioAssetId !== asset.id ? s : null;
    },
    { label: "new take" },
  );
  const again = await check();
  expect(again).toMatchObject({ resolved: 1 });
  expect(await audioFindings()).toEqual([]);
});

test("paste mode: the fix parks for an answer, and lines no finding names are refused", async () => {
  await alice.patch(`/api/narration-lines/${(await narration()).lines[2]!.id}`, { text: "Ines waited. [[mock:lint]]" });
  await alice.patch(`/api/narration-lines/${(await narration()).lines[3]!.id}`, {
    text: "Ines kept waiting. [[mock:lint]]",
  });
  const lint = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapterId}/narration/lint`,
    { semantic: true, ai: { manual: true } },
    202,
  );
  await finished(lint.job.id, "awaiting_input");
  const view = await alice.get<{ prompt: string; format: { name: string } }>(`/api/generations/${lint.job.id}/manual`);
  expect(view.format.name).toBe("NarrationLintReport");
  await alice.post(
    `/api/generations/${lint.job.id}/manual`,
    {
      text: JSON.stringify({
        findings: [{ type: "repeated_meaning", lines: ["L3", "L4", "L99"], explanation: "Both say she waited." }],
      }),
    },
    202,
  );
  await finished(lint.job.id);
  const ai = (await findings("?status=open")).findings.find((f) => f.check === "ai")!;
  expect(ai.lineIds).toHaveLength(2);

  const fix = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapterId}/narration/fix`,
    { findingIds: [ai.id], ai: { manual: true } },
    202,
  );
  await finished(fix.job.id, "awaiting_input");
  await alice.post(
    `/api/generations/${fix.job.id}/manual`,
    {
      text: JSON.stringify({
        lines: [
          { line: "L1", text: "Not flagged, so not taken." },
          { line: "L4", text: "The hours went by on the jetty." },
        ],
      }),
    },
    202,
  );
  const done = await finished(fix.job.id);
  expect((done.result as { proposals: { key: string }[] }).proposals.map((p) => p.key)).toEqual(["L4"]);
});
