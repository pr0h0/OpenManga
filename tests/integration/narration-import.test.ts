import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { eq, generationJobs } from "@openmanga/db";
import { pcmToWav } from "../../packages/audio/src/index.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let chapterId: string;
let whisper: ReturnType<typeof Bun.serve>;

type Seg = {
  id: string;
  text: string;
  stale: boolean;
  activeAudioAssetId: string | null;
  audio: { provider: string; voice: string; durationMs: number } | null;
};
type Doc = { lines: { segments: Seg[] }[] };
const segments = async () =>
  (await alice.get<Doc>(`/api/chapters/${chapterId}/narration`)).lines.flatMap((l) => l.segments);
const job = async (id: string) => (await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;

const RATE = 24_000;
const LINES = [
  "Tomas lit the lamp before the storm.",
  "Ines watched from the jetty, pred udaju.",
  "This line is not in the recording.",
];
// What the narrator says: the first two lines, "pred udaju" run together as one word, a cough between them.
const SPOKEN = [
  ["Tomas", "lit", "the", "lamp", "before", "the", "storm."],
  ["ahem"],
  ["Ines", "watched", "from", "the", "jetty,", "predudaju."],
];
const WORD_S = 0.3;
const GAP_S = 0.05;
const PAUSE_S = 0.7;

/** A recording of SPOKEN: each word a tone, short gaps inside a sentence, a pause between sentences. */
function recording() {
  const samples: number[] = [];
  const words: [number, number, string][] = [];
  const silence = (s: number) => {
    for (let i = 0; i < Math.round(s * RATE); i++) samples.push(0);
  };
  silence(0.5);
  for (const sentence of SPOKEN) {
    for (const w of sentence) {
      const start = samples.length / RATE;
      for (let i = 0; i < Math.round(WORD_S * RATE); i++) samples.push(Math.round(8000 * Math.sin(i / 6)));
      words.push([start, start + WORD_S, w]);
      silence(GAP_S);
    }
    silence(PAUSE_S);
  }
  return { wav: pcmToWav(new Uint8Array(Int16Array.from(samples).buffer), RATE), words };
}
const rec = recording();

beforeAll(async () => {
  // A stand-in for services/whisper: answers with the recording's words in its NDJSON format.
  whisper = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.arrayBuffer();
      const lines = [
        { duration: rec.words.at(-1)![1] + PAUSE_S, language: "en" },
        { words: rec.words.slice(0, 8), end: 3 },
        { words: rec.words.slice(8), end: 6 },
        { done: true },
      ];
      return new Response(lines.map((l) => `${JSON.stringify(l)}\n`).join(""), {
        headers: { "content-type": "application/x-ndjson" },
      });
    },
  });
  h = await startHarness();
  h.workerDeps.config.WHISPER_URL = `http://127.0.0.1:${whisper.port}`;
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "narrator", email: "n@example.com", password: "np-pass-1234" },
    201,
  );
  ({
    project: { id: projectId },
  } = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Recorded" }, 201));
  ({
    chapter: { id: chapterId },
  } = await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201));
  for (const text of LINES) await alice.post(`/api/chapters/${chapterId}/narration/lines`, { text }, 201);
});
afterAll(async () => {
  whisper?.stop(true);
  await h?.stop();
});

test("a recording is cut into the segments it reads; a segment it does not read keeps no audio", async () => {
  const res = await alice.raw(
    "POST",
    `/api/chapters/${chapterId}/narration/import?name=take.wav`,
    new Blob([rec.wav], { type: "audio/wav" }),
  );
  expect(res.status).toBe(202);
  const { job: queued } = (await res.json()) as { job: { id: string } };
  const done = await waitFor(async () => {
    const j = await job(queued.id);
    return ["completed", "failed"].includes(j.status) ? j : null;
  });
  expect(done.failureReason).toBeNull();
  expect(done.result).toMatchObject({ segments: 3, attached: 2, missedCount: 1 });

  const [a, b, c] = await segments();
  expect(a!.audio).toMatchObject({ provider: "import", voice: "imported" });
  expect(a!.stale).toBe(false);
  // Seven words and their gaps, trimmed of the pause around them: the cough before b is not in a.
  const sentence = (n: number) => (n * (WORD_S + GAP_S) - GAP_S) * 1000;
  expect(Math.abs(a!.audio!.durationMs - sentence(7))).toBeLessThan(80);
  expect(Math.abs(b!.audio!.durationMs - sentence(6))).toBeLessThan(80);
  expect(c!.audio).toBeNull();
  // The upload is not kept once the job is done.
  expect(await readdir(join(h.config.TEMP_ROOT, "narration-imports"))).toEqual([]);
});

test("imported audio stays current under another voice, and 'synthesize missing' leaves it alone", async () => {
  await alice.patch(`/api/projects/${projectId}`, { settings: { narrationVoice: "am_adam", narrationSpeed: 1.2 } });
  const segs = await segments();
  expect(segs.slice(0, 2).every((s) => s.audio?.provider === "import" && !s.stale)).toBe(true);
  const r = await alice.post<{ queued: number }>(`/api/chapters/${chapterId}/narration/synthesize`, {}, 202);
  expect(r.queued).toBe(1);
  // Once the third segment is voiced under the new settings, nothing in the project counts as outdated audio.
  await waitFor(async () => (await segments())[2]!.audio, { label: "third segment voiced" });
  const st = await alice.get<{ stages: { key: string; count: number }[] }>(`/api/projects/${projectId}/staleness`);
  expect(st.stages.find((x) => x.key === "audio")?.count).toBe(0);
});

test("one segment's take can be uploaded, and editing the text detaches it", async () => {
  const [, , c] = await segments();
  const one = pcmToWav(new Uint8Array(RATE * 2).fill(40), RATE);
  const res = await alice.raw("POST", `/api/narration-segments/${c!.id}/audio?name=c.wav`, new Blob([one]));
  expect(res.status).toBe(200);
  let seg = (await segments())[2]!;
  expect(seg.audio).toMatchObject({ provider: "import" });
  await alice.patch(`/api/narration-segments/${c!.id}`, { text: "A different line now." });
  seg = (await segments())[2]!;
  expect(seg.activeAudioAssetId).toBeNull();

  const bad = await alice.raw("POST", `/api/narration-segments/${c!.id}/audio`, new Blob([new Uint8Array(500)]));
  expect(bad.status).toBe(400);
});

test("an import needs narration in that language", async () => {
  const res = await alice.raw(
    "POST",
    `/api/chapters/${chapterId}/narration/import?language=de`,
    new Blob([rec.wav], { type: "audio/wav" }),
  );
  expect(res.status).toBe(400);
});
