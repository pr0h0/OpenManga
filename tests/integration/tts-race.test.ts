import { afterAll, beforeAll, expect, test } from "bun:test";
import { assets, audioAssets, audioJobs, eq, narrationLines } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "voicer", email: "voice@example.com", password: "voice-pass-123" },
    201,
  );
});
afterAll(() => h?.stop());

test("a segment deleted while it is being voiced ends its job cleanly and drops the audio", async () => {
  const { project } = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Race" }, 201);
  const { chapter } = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${project.id}/chapters`,
    { title: "One" },
    201,
  );
  await alice.post(`/api/chapters/${chapter.id}/narration/lines`, { text: "The lamp turns at three." }, 201);
  const doc = await alice.get<{ lines: { id: string; segments: { id: string }[] }[] }>(
    `/api/chapters/${chapter.id}/narration`,
  );
  const line = doc.lines[0]!;

  // The voice finishes only after the line was rewritten away, as when a narration re-run replaces it.
  const resolver = h.workerDeps.resolver;
  const original = resolver.tts.bind(resolver);
  resolver.tts = async (...a: Parameters<typeof resolver.tts>) => {
    const real = await original(...a);
    if (!real) return real;
    return {
      ...real,
      synthesize: async (req: Parameters<typeof real.synthesize>[0]) => {
        const out = await real.synthesize(req);
        await h.deps.db.delete(narrationLines).where(eq(narrationLines.id, line.id));
        return out;
      },
    } as typeof real;
  };
  // The segment's audio job goes with it (cascade), so what is left to check is that the handler ends cleanly: it
  // drops the audio it made instead of failing on the missing segment.
  const store = h.workerDeps.assets;
  const hardDelete = store.hardDelete.bind(store);
  let dropped = false;
  store.hardDelete = async (a: Parameters<typeof store.hardDelete>[0]) => {
    dropped = true;
    return hardDelete(a);
  };
  try {
    await alice.post(`/api/narration-segments/${line.segments[0]!.id}/synthesize`, { force: true }, 202);
    await waitFor(async () => dropped, { label: "orphaned audio dropped" });
    await waitFor(
      async () =>
        (await h.deps.db.select().from(assets).where(eq(assets.projectId, project.id))).every(
          (x) => x.type !== "audio",
        ),
      { label: "no audio asset left" },
    );
    expect((await h.deps.db.select().from(audioAssets).where(eq(audioAssets.projectId, project.id))).length).toBe(0);
    expect((await h.deps.db.select().from(audioJobs).where(eq(audioJobs.projectId, project.id))).length).toBe(0);
  } finally {
    resolver.tts = original;
    store.hardDelete = hardDelete;
  }
});
