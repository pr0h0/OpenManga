import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs } from "@openmanga/db";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let ch1: string;
let ruleId: string;

type Report = {
  findings: {
    id: string;
    status: string;
    severity: string;
    quote: string;
    factId: string | null;
    place: { ref: string; panelId?: string; pageId?: string };
    resolution: string;
  }[];
  rules: { factId: string; verdict: string | null; chapters: { order: number; verdict: string; note: string }[] }[];
  running: number;
};

const job = async (id: string) => (await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
const settled = (id: string, status = "completed") =>
  waitFor(async () => ((await job(id)).status === status ? job(id) : null), { label: status, timeoutMs: 60_000 });
const report = (status = "all") => alice.get<Report>(`/api/projects/${projectId}/continuity?status=${status}`);
const check = async () => {
  const r = await alice.post<{ jobs: { id: string }[] }>(
    `/api/projects/${projectId}/continuity-checks`,
    { confirm: true },
    202,
  );
  for (const j of r.jobs) await settled(j.id);
  return r.jobs;
};

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "editor", email: "e@example.com", password: "editor-pass-12" },
    201,
  );
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "No Guns" }, 201)).project.id;
  await alice.post(`/api/projects/${projectId}/characters`, { name: "Jin", description: { hair: "black" } }, 201);
  const chapter = async (title: string) =>
    (await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title }, 201)).chapter.id;
  ch1 = await chapter("Standoff");
  await chapter("Not planned yet");
  ruleId = (
    await alice.post<{ fact: { id: string } }>(
      `/api/projects/${projectId}/bible/facts`,
      { kind: "rule", text: "No guns exist in this world.", fixed: true, visual: true },
      201,
    )
  ).fact.id;
  const panel = (beat: string) => ({ spec: { beat, characters: [{ characterId: "Jin" }] } });
  await applyChapterPlan(
    h.deps.db,
    ch1,
    ChapterPlan.parse({
      scenes: [
        {
          title: "The alley",
          pages: [{ panels: [panel("[[mock:contradiction]] Jin draws a gun"), panel("Jin runs")] }],
        },
      ],
    }),
    { replace: true },
  );
});
afterAll(() => h?.stop());

test("a check is estimated first and only covers chapters with something to check", async () => {
  const est = await alice.post<{ confirmRequired: boolean; count: number; skipped: number }>(
    `/api/projects/${projectId}/continuity-checks`,
    {},
  );
  expect(est).toMatchObject({ confirmRequired: true, count: 1, skipped: 1 });
});

test("findings name the place and the rule; the rule fails in that chapter", async () => {
  const [run] = await check();
  const done = await job(run!.id);
  expect(done.compiledPrompt).toContain("[template:continuity-check-v1]");
  expect(done.compiledPrompt).toContain("No guns exist in this world.");
  expect(done.compiledPrompt).toContain('"ref":"p1.1"');
  const r = await report();
  expect(r.findings).toHaveLength(1);
  const f = r.findings[0]!;
  expect(f).toMatchObject({ status: "open", severity: "high", factId: ruleId });
  expect(f.place.ref).toBe("p1.1");
  expect(f.place.panelId).toBeTruthy();
  expect(f.place.pageId).toBeTruthy();
  expect(r.rules).toEqual([
    expect.objectContaining({
      factId: ruleId,
      verdict: "fail",
      chapters: [expect.objectContaining({ order: 1, verdict: "fail" })],
    }),
  ]);
});

test("an ignored finding is not raised again; explaining one adds a bible fact", async () => {
  const [f] = (await report("open")).findings;
  await alice.patch(`/api/continuity-findings/${f!.id}`, { status: "ignored", reason: "a flashback in a dream" });
  await check();
  const after = await report();
  expect(after.findings.filter((x) => x.status === "open")).toHaveLength(0);
  expect(after.findings[0]).toMatchObject({ status: "ignored", resolution: "a flashback in a dream" });

  await alice.patch(`/api/continuity-findings/${f!.id}`, { status: "open" });
  const explained = await alice.post<{ fact: { id: string; source: string }; finding: { status: string } }>(
    `/api/continuity-findings/${f!.id}/explain`,
    { fact: { kind: "object", subject: "Jin", text: "The dream gun is a toy.", fromChapterId: ch1 } },
    201,
  );
  expect(explained.fact.source).toBe("continuity");
  expect(explained.finding.status).toBe("explained");
  const bible = await alice.get<{ facts: { text: string }[] }>(`/api/projects/${projectId}/bible`);
  expect(bible.facts.map((x) => x.text)).toContain("The dream gun is a toy.");
});

test("a check runs without a key: it parks for a pasted ContinuityReport", async () => {
  const r = await alice.post<{ jobs: { id: string }[] }>(
    `/api/projects/${projectId}/continuity-checks`,
    { confirm: true, chapterId: ch1, ai: { manual: true } },
    202,
  );
  const id = r.jobs[0]!.id;
  await settled(id, "awaiting_input");
  await alice.post(
    `/api/generations/${id}/manual`,
    {
      text: JSON.stringify({
        findings: [{ severity: "low", message: "Jin runs on a broken leg.", where: "p1.2", quote: "Jin runs" }],
        rules: [{ rule: "R1", verdict: "warn", note: "unclear" }],
      }),
    },
    202,
  );
  await settled(id);
  const after = await report("open");
  expect(after.findings.map((x) => x.place.ref)).toEqual(["p1.2"]);
  expect(after.rules[0]!.chapters[0]).toMatchObject({ verdict: "warn", note: "unclear" });
});
