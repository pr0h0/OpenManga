import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, projects } from "@openmanga/db";
import { pipelineStaleness } from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "speaker", email: "speak@example.com", password: "speak-pass-123" },
    201,
  );
});
afterAll(() => h?.stop());

type Doc = { lines: { text: string; segments: { id: string; text: string; stale: boolean; audio: unknown }[] }[] };

test("the dictionary changes only what the voice is sent, and re-voices only the segments it affects", async () => {
  const said: string[] = [];
  const resolver = h.workerDeps.resolver;
  const original = resolver.tts.bind(resolver);
  resolver.tts = async (...a: Parameters<typeof resolver.tts>) => {
    const real = await original(...a);
    if (!real) return real;
    return {
      ...real,
      synthesize: (req: Parameters<typeof real.synthesize>[0]) => {
        said.push(req.text);
        return real.synthesize(req);
      },
    } as typeof real;
  };
  try {
    const { project } = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Qi" }, 201);
    const { chapter } = await alice.post<{ chapter: { id: string } }>(
      `/api/projects/${project.id}/chapters`,
      { title: "One" },
      201,
    );
    await alice.post(`/api/chapters/${chapter.id}/narration/lines`, { text: "Qi gathers in the hall." }, 201);
    await alice.post(`/api/chapters/${chapter.id}/narration/lines`, { text: "The rain kept falling." }, 201);
    const narration = () => alice.get<Doc>(`/api/chapters/${chapter.id}/narration`);
    const voiced = async () => (await narration()).lines.every((l) => l.segments.every((s) => s.audio && !s.stale));

    await alice.post(`/api/chapters/${chapter.id}/narration/synthesize`, {}, 202);
    await waitFor(voiced, { label: "first synthesis" });
    expect(said.sort()).toEqual(["Qi gathers in the hall.", "The rain kept falling."]);

    await alice.patch(`/api/projects/${project.id}`, { settings: { pronunciation: [{ term: "qi", spoken: "chee" }] } });
    const after = await narration();
    // Shown text keeps the written form; only the affected segment's audio is stale.
    expect(after.lines.map((l) => [l.text, l.segments[0]!.stale])).toEqual([
      ["Qi gathers in the hall.", true],
      ["The rain kept falling.", false],
    ]);
    const [p] = await h.deps.db.select().from(projects).where(eq(projects.id, project.id));
    const audio = (await pipelineStaleness(h.deps.db, p!)).stages.find((s) => s.key === "audio");
    expect(audio?.count).toBe(1);

    said.length = 0;
    const r = await alice.post<{ queued: number }>(`/api/chapters/${chapter.id}/narration/synthesize`, {}, 202);
    expect(r.queued).toBe(1);
    await waitFor(voiced, { label: "re-synthesis" });
    expect(said).toEqual(["chee gathers in the hall."]);

    // Clearing the dictionary brings back the earlier take from the cache instead of voicing it again.
    said.length = 0;
    await alice.patch(`/api/projects/${project.id}`, { settings: { pronunciation: [] } });
    await alice.post(`/api/chapters/${chapter.id}/narration/synthesize`, {}, 202);
    await waitFor(voiced, { label: "cached take" });
    expect(said).toEqual([]);
  } finally {
    resolver.tts = original;
  }
});
