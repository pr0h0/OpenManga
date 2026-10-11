import { afterAll, beforeAll, expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let panelId: string;
let refAssetId: string;

type Record_ = {
  format: string;
  app: { name: string; version: string };
  story: { revision: number } | null;
  models: { kind: string; provider: string | null; model: string | null }[];
  panels: {
    chapter: number;
    page: number;
    panel: number;
    art: { source: string; job: { provider: string; template: string; promptSha256: string } | null } | null;
  }[];
  references: { name: string; source: string; uploadedName: string | null; licence: { text: string } | null }[];
  fonts: { name: string; licence: string }[];
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
  await u.post("/api/auth/register", { username: "prov", email: "pr@example.com", password: "prov-pass-12345" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Origins", story: { content: STORY } }, 201)
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
  const { panels } = await u.get<{ panels: { id: string; characterVersionIds: string[] }[] }>(
    `/api/chapters/${chapterId}/panels`,
  );
  const withCast = panels.find((p) => p.characterVersionIds.length)!;
  panelId = withCast.id;
  // An uploaded reference of a character in that panel, with its licence noted.
  const png = await sharp({ create: { width: 600, height: 900, channels: 3, background: "#884422" } })
    .png()
    .toBuffer();
  const form = new FormData();
  form.set("file", new File([new Uint8Array(png)], "woojin-photo.png", { type: "image/png" }));
  form.set("kind", "portrait");
  const up = await u.json<{ reference: { assetId: string } }>(
    "POST",
    `/api/character-versions/${withCast.characterVersionIds[0]}/references/upload`,
    form,
    201,
  );
  refAssetId = up.reference.assetId;
  await u.put(`/api/assets/${refAssetId}/marks`, {
    licence: { text: "CC BY 4.0, photo by A. Example", url: "https://creativecommons.org/licenses/by/4.0/" },
  });
  await done((await u.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202)).job.id);
}, 180_000);
afterAll(() => h?.stop());

test("a chapter's provenance: build, story, each panel's job and prompt, references with licences, fonts", async () => {
  const r = await u.get<Record_>(`/api/projects/${projectId}/provenance?chapterId=${chapterId}`);
  expect(r.format).toBe("openmanga-provenance/1");
  expect(r.app.name).toBe("OpenManga");
  expect(r.story?.revision).toBe(1);
  const drawn = r.panels.filter((p) => p.art);
  expect(drawn).toHaveLength(1);
  expect(drawn[0]!.art).toMatchObject({ source: "generated" });
  expect(drawn[0]!.art!.job!.template).toMatch(/^panel-generation v\d+$/);
  expect(drawn[0]!.art!.job!.promptSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(r.models.some((m) => m.kind === "image")).toBe(true);
  expect(r.models.some((m) => m.kind === "text")).toBe(true);
  const ref = r.references.find((x) => x.uploadedName === "woojin-photo.png")!;
  expect(ref).toMatchObject({ source: "uploaded", licence: { text: "CC BY 4.0, photo by A. Example" } });
  expect(r.fonts.find((f) => f.name === "Comic Neue")?.licence).toBe("SIL Open Font License 1.1");
  const md = await (
    await u.raw("GET", `/api/projects/${projectId}/provenance?chapterId=${chapterId}&format=md`)
  ).text();
  expect(md).toStartWith("# Provenance: Origins");
  expect(md).toContain("licence: CC BY 4.0, photo by A. Example");
});

test("an export ships the record next to its files when asked, and only then", async () => {
  const run = async (provenance: boolean) => {
    const ex = await u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "png_pages", chapterId, acknowledgeIssues: true, provenance },
      202,
    );
    return waitFor(
      async () => {
        const j = await u.get<{ job: { status: string; files: { assetId: string; fileName: string }[] } }>(
          `/api/jobs/${ex.job.id}`,
        );
        return j.job.status === "completed" ? j.job : null;
      },
      { label: "export", timeoutMs: 60_000 },
    );
  };
  const plain = await run(false);
  expect(plain.files.some((f) => f.fileName.includes("_provenance"))).toBe(false);
  const withRecord = await run(true);
  const json = withRecord.files.find((f) => f.fileName.endsWith("_provenance.json"))!;
  expect(withRecord.files.some((f) => f.fileName.endsWith("_provenance.md"))).toBe(true);
  const rec = (await (await u.raw("GET", `/cdn/a/${json.assetId}`)).json()) as Record_;
  expect(rec.panels.length).toBeGreaterThan(0);
  expect(rec.references.some((x) => x.licence?.text.startsWith("CC BY"))).toBe(true);
});
