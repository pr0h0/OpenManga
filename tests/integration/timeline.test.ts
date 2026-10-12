import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let bob: TestClient;
let projectId: string;
let mira: string;
let ch1: string;
let ch2: string;

type Event = {
  id: string;
  title: string;
  day: number | null;
  elapsed: string | null;
  outOfOrder: boolean;
  ages: Record<string, number>;
  chapterId: string | null;
  source: string;
};
type Timeline = {
  events: Event[];
  states: { text: string; eventId: string | null }[];
  extraction: { id: string; status: string } | null;
};
const timeline = () => alice.get<Timeline>(`/api/projects/${projectId}/timeline`);
const add = (b: Record<string, unknown>) =>
  alice.post<{ event: { id: string } }>(`/api/projects/${projectId}/timeline/events`, b, 201);

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "chrono", email: "ch@example.com", password: "chrono-pass-12" },
    201,
  );
  await bob.post(
    "/api/auth/register",
    { username: "outsider", email: "ou@example.com", password: "outsider-pass-1" },
    201,
  );
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Lighthouse" }, 201)).project.id;
  mira = (
    await alice.post<{ character: { id: string } }>(
      `/api/projects/${projectId}/characters`,
      { name: "Mira", description: { hair: "black" } },
      201,
    )
  ).character.id;
  const chapter = async (title: string, sourceExcerpt: string) =>
    (
      await alice.post<{ chapter: { id: string } }>(
        `/api/projects/${projectId}/chapters`,
        { title, sourceExcerpt },
        201,
      )
    ).chapter.id;
  ch1 = await chapter("The storm", "Mira, seventeen, climbed the lighthouse in the storm.");
  ch2 = await chapter("Morning", "Three days later the keeper came home.");
}, 60_000);
afterAll(() => h?.stop());

test("events in story-time order: elapsed time, ages from a birth, a day running backwards flagged", async () => {
  await add({ kind: "birth", title: "Mira is born", day: 0, characterIds: [mira] });
  const storm = await add({ title: "The storm", day: 365.25 * 17 + 30, chapterId: ch1, characterIds: [mira] });
  await add({ title: "The keeper returns", day: 365.25 * 17 + 33, chapterId: ch2, sceneNumber: 1 });
  // Inserted at the very start: a flashback told later, but earlier in story time.
  await add({ title: "The keeper leaves", when: "the night before", after: null });
  let t = await timeline();
  expect(t.events.map((e) => e.title)).toEqual([
    "The keeper leaves",
    "Mira is born",
    "The storm",
    "The keeper returns",
  ]);
  expect(t.events[2]!.ages).toEqual({ [mira]: 17 });
  expect(t.events[3]!.elapsed).toBe("3 days");
  // Moved after the storm with a day before it: flagged.
  await alice.patch(`/api/timeline-events/${storm.event.id}`, { day: 365.25 * 17 + 40 });
  t = await timeline();
  expect(t.events.find((e) => e.title === "The keeper returns")!.outOfOrder).toBe(true);
  // Every event once, or refused.
  const ids = t.events.map((e) => e.id);
  await alice.post(`/api/projects/${projectId}/timeline/order`, { ids: ids.slice(1) }, 400);
  await alice.post(`/api/projects/${projectId}/timeline/order`, { ids: [ids[1], ids[0], ids[2], ids[3]] });
  expect((await timeline()).events[0]!.title).toBe("Mira is born");
  // Another project's chapter or character, and another user, are refused.
  await alice.post(
    `/api/projects/${projectId}/timeline/events`,
    { title: "Bad", characterIds: [crypto.randomUUID()] },
    400,
  );
  await alice.post(`/api/projects/${projectId}/timeline/events`, { title: "Bad", chapterId: crypto.randomUUID() }, 400);
  await bob.get(`/api/projects/${projectId}/timeline`, 404);
});

test("bible states sit at the event of the chapter and scene they start from", async () => {
  await alice.post(
    `/api/projects/${projectId}/bible/states`,
    { characterId: mira, kind: "injury", text: "Cut on the left hand", chapterId: ch2, sceneNumber: 2 },
    201,
  );
  await alice.post(
    `/api/projects/${projectId}/bible/states`,
    { characterId: mira, kind: "item", text: "Carries a match box" },
    201,
  );
  const t = await timeline();
  const returns = t.events.find((e) => e.title === "The keeper returns")!;
  expect(t.states.find((s) => s.text === "Cut on the left hand")!.eventId).toBe(returns.id);
  expect(t.states.find((s) => s.text === "Carries a match box")!.eventId).toBeNull();
});

test("extraction proposes events; applying merges dated ones by day, once", async () => {
  const { job } = await alice.post<{ job: { id: string } }>(`/api/projects/${projectId}/timeline/extract`, {}, 202);
  await waitFor(
    async () => {
      const t = await timeline();
      return t.extraction?.status === "completed" || t.extraction?.status === "failed" ? t : null;
    },
    { label: "timeline extraction", timeoutMs: 60_000 },
  );
  const before = (await timeline()).events.length;
  const r = await alice.post<{ events: number; skipped: unknown[] }>(`/api/timeline-extractions/${job.id}/apply`, {});
  expect(r.events).toBeGreaterThan(0);
  const t = await timeline();
  expect(t.events.length).toBe(before + r.events);
  const extracted = t.events.filter((e) => e.source === "extracted");
  expect(extracted.some((e) => e.chapterId === ch1)).toBe(true);
  // Dated events stay in day order where they were merged.
  const days = extracted.filter((e) => e.day !== null).map((e) => e.day!);
  expect(days).toEqual([...days].sort((a, b) => a - b));
  await alice.post(`/api/timeline-extractions/${job.id}/apply`, {}, 409);
}, 120_000);

test("MCP: read the timeline and add an event", async () => {
  const { token } = await alice.post<{ token: string }>(
    "/api/agents/tokens",
    {
      name: "timeline agent",
      scopes: ["story:read", "story:write"],
      projectAccess: "all",
      approvalMode: "ALLOW_ALL",
    },
    201,
  );
  const client = new Client({ name: "timeline-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, init) => {
        const headers = new Headers((init as RequestInit).headers);
        headers.set("host", "test.local");
        return Promise.resolve(h.app.request(String(url), { ...(init as RequestInit), headers }));
      },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { structuredContent?: Record<string, unknown> };
    return r.structuredContent as Record<string, unknown> & { data: Record<string, unknown> };
  };
  const added = await call("manage_timeline", {
    action: "add",
    projectId,
    event: { title: "The lamp is relit", day: 365.25 * 17 + 31 },
  });
  expect((added.data.event as { title: string }).title).toBe("The lamp is relit");
  const id = (added.data.event as { id: string }).id;
  // Editing one field leaves the others as they were.
  await call("manage_timeline", { action: "edit", id, event: { when: "that night" } });
  const read = await call("get_timeline", { projectId });
  const relit = (read.data.events as (Event & { when: string })[]).find((e) => e.id === id)!;
  expect(relit).toMatchObject({ title: "The lamp is relit", when: "that night", day: 365.25 * 17 + 31 });
  await client.close();
});
