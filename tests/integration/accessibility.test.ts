import { afterAll, beforeAll, expect, test } from "bun:test";
import { dialogueLines, eq, panels } from "@openmanga/db";
import { unzipSync } from "fflate";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows.
The door slammed shut with a BANG.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let pageId: string;
let panelIds: string[];

type Alt = { alt: string; panels: { panelId: string; alt: string; custom: boolean; suggested: string }[] };
type Report = {
  altText: { panels: number; written: number; empty: string[] };
  readingOrder: { pageId: string; expected: number[] }[];
  lettering: { kind: string; pageId: string; value: number }[];
};
const done = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "a11y", email: "a1@example.com", password: "a11y-pass-1234" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Readable", story: { content: STORY } }, 201)
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202)).job.id);
  const ch = await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
  for (const pg of ch.pages) await u.post(`/api/pages/${pg.id}/letter-from-plan`, {});
  // The page with the most panels.
  let best = { id: "", n: 0 };
  for (const pg of ch.pages) {
    const n = (await h.deps.db.select({ id: panels.id }).from(panels).where(eq(panels.pageId, pg.id))).length;
    if (n > best.n) best = { id: pg.id, n };
  }
  pageId = best.id;
  panelIds = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`)).panels.map((p) => p.id);
}, 180_000);
afterAll(() => h?.stop());

test("alt text from the story, a hand-written one kept, even on a locked panel", async () => {
  const before = await u.get<Alt>(`/api/pages/${pageId}/alt-text`);
  expect(before.panels.length).toBeGreaterThan(1);
  expect(before.panels.every((p) => !p.custom && p.alt.length > 10)).toBe(true);
  expect(before.alt).toContain(before.panels[0]!.alt);
  await u.patch(`/api/panels/${panelIds[0]}`, { approvalStatus: "locked" });
  await u.patch(`/api/panels/${panelIds[0]}`, { altText: "Rain sheets across an empty rooftop at night." });
  await u.patch(`/api/panels/${panelIds[0]}`, { storyBeat: "changed" }, 409);
  const after = await u.get<Alt>(`/api/pages/${pageId}/alt-text`);
  expect(after.panels[0]).toMatchObject({ custom: true, alt: "Rain sheets across an empty rooftop at night." });
  expect(after.alt).toStartWith("Rain sheets across an empty rooftop at night.");
});

test("checks: hand-written alt text counted, a page read out of order, faint and tiny lettering", async () => {
  // Swap where the first two panels sit, so their numbers no longer follow the page.
  const [a, b] = await Promise.all(
    panelIds.slice(0, 2).map(async (id) => (await h.deps.db.select().from(panels).where(eq(panels.id, id)))[0]!),
  );
  await h.deps.db.update(panels).set({ frame: b!.frame }).where(eq(panels.id, a!.id));
  await h.deps.db.update(panels).set({ frame: a!.frame }).where(eq(panels.id, b!.id));
  const [line] = await h.deps.db.select().from(dialogueLines).where(eq(dialogueLines.pageId, pageId));
  await h.deps.db
    .update(dialogueLines)
    .set({ bubble: { ...line!.bubble, textColor: "#bbbbbb", fontSize: 12 } })
    .where(eq(dialogueLines.id, line!.id));
  const r = await u.get<Report>(`/api/projects/${projectId}/accessibility?chapterId=${chapterId}`);
  expect(r.altText.written).toBe(1);
  expect(r.readingOrder.map((x) => x.pageId)).toContain(pageId);
  const mine = r.lettering.filter((l) => l.pageId === pageId).map((l) => l.kind);
  expect(mine).toEqual(expect.arrayContaining(["contrast", "size"]));
});

test("the narration transcript, an EPUB that describes its pages, and a reader link's alt text", async () => {
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/narration/generate`, {}, 202)).job.id);
  const transcript = await (await u.raw("GET", `/api/projects/${projectId}/transcript`)).text();
  expect(transcript).toStartWith("# Readable");
  expect(transcript).toContain("## Chapter 1:");
  expect(transcript.split("\n").filter((l) => l.trim()).length).toBeGreaterThan(3);
  const ex = await u.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { kind: "epub", chapterId, acknowledgeIssues: true },
    202,
  );
  const job = await waitFor(
    async () => {
      const j = await u.get<{ job: { status: string; files: { assetId: string; fileName: string }[] } }>(
        `/api/jobs/${ex.job.id}`,
      );
      return j.job.status === "completed" ? j.job : null;
    },
    { label: "epub", timeoutMs: 120_000 },
  );
  const epub = unzipSync(new Uint8Array(await (await u.raw("GET", `/cdn/a/${job.files[0]!.assetId}`)).arrayBuffer()));
  const opf = new TextDecoder().decode(epub["OEBPS/content.opf"]);
  expect(opf).toContain('<meta property="schema:accessibilityFeature">alternativeText</meta>');
  expect(opf).toContain('<meta property="schema:accessModeSufficient">textual</meta>');
  const pagesXhtml = Object.keys(epub)
    .filter((k) => /OEBPS\/p\d+\.xhtml$/.test(k))
    .map((k) => new TextDecoder().decode(epub[k]));
  expect(pagesXhtml.some((x) => x.includes('alt="Rain sheets across an empty rooftop at night.'))).toBe(true);
  const share = await u.post<{ share: { token: string } }>(`/api/projects/${projectId}/shares`, { chapterId }, 201);
  const reader = await h
    .client()
    .get<{ chapters: { pages: { id: string; alt: string }[] }[] }>(`/api/public/shares/${share.share.token}`);
  const page = reader.chapters[0]!.pages.find((p) => p.id === pageId)!;
  expect(page.alt).toStartWith("Rain sheets across an empty rooftop at night.");
}, 240_000);
