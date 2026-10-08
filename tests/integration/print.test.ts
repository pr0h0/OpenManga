import { afterAll, beforeAll, expect, test } from "bun:test";
import { dialogueLines, eq, projects } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { mockImagePng } from "@openmanga/testing";
import { PDFDict, PDFDocument, PDFHexString, PDFName } from "pdf-lib";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let coverAssetId: string;
const firstPages: string[] = [];

type Job = {
  id: string;
  status: string;
  failureReason: string | null;
  result: Record<string, unknown> | null;
  files: { assetId: string; fileName: string; mimeType: string }[];
};

async function exportAndWait(body: Record<string, unknown>) {
  const r = await alice.post<{ job: { id: string } }>(`/api/projects/${projectId}/exports`, body, 202);
  const done = await waitFor(
    async () => {
      const l = await alice.get<{ jobs: Job[] }>(`/api/projects/${projectId}/exports`);
      const j = l.jobs.find((x) => x.id === r.job.id);
      return j && ["completed", "failed"].includes(j.status) ? j : null;
    },
    { timeoutMs: 120_000, label: `export ${body.kind}` },
  );
  expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
  return done;
}
const download = async (assetId: string) =>
  new Uint8Array(await (await alice.raw("GET", `/cdn/a/${assetId}`)).arrayBuffer());

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "printer", email: "pr@example.com", password: "print-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Rooftop Nights" }, 201);
  projectId = p.project.id;
  for (const [title, count] of [
    ["One", 3],
    ["Two", 2],
  ] as const) {
    const ch = await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title }, 201);
    for (let i = 0; i < count; i++) {
      const page = await alice.post<{ page: { id: string } }>(
        `/api/chapters/${ch.chapter.id}/pages`,
        { layoutTemplate: "four-grid" },
        201,
      );
      if (i === 0) firstPages.push(page.page.id);
      const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
      for (const panel of doc.panels) {
        const f = new FormData();
        const png = await mockImagePng({ width: 64, height: 64, prompt: `${title} ${i} ${panel.id}` });
        f.set("file", new File([png as BlobPart], "art.png", { type: "image/png" }));
        expect((await alice.raw("POST", `/api/panels/${panel.id}/artwork/upload`, f)).status).toBe(201);
      }
    }
  }
  // A bubble against the left edge of the book's first page: the binding side of a recto.
  const line = await alice.post<{ dialogue: { id: string; bubble: Record<string, unknown> } }>(
    `/api/pages/${firstPages[0]}/dialogue`,
    { text: "Too close to the gutter" },
    201,
  );
  await h.deps.db
    .update(dialogueLines)
    .set({ bubble: { ...line.dialogue.bubble, x: 0.005, y: 0.45 } as never })
    .where(eq(dialogueLines.id, line.dialogue.id));
  // Cover art sharp enough for a 6" × 9" front with bleed at 300 DPI.
  const art = new Uint8Array(
    await sharp({ create: { width: 1900, height: 2850, channels: 3, background: "#2a6f97" } })
      .png()
      .toBuffer(),
  );
  const cover = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type: "cover",
    data: art,
    mimeType: "image/png",
    width: 1900,
    height: 2850,
    metadata: {},
  });
  coverAssetId = cover.id;
  const [row] = await h.deps.db.select().from(projects).where(eq(projects.id, projectId));
  await h.deps.db
    .update(projects)
    .set({
      coverAssetId,
      description: "Rain hammered the city as Woo Jin climbed onto the rooftop.",
      settings: { ...row!.settings, author: "Jin Park" },
    })
    .where(eq(projects.id, projectId));
}, 120_000);
afterAll(() => h?.stop());

const book = { pageSize: "kdp_6x9", toc: true, rectoChapters: true };

test("the PDF interior: a contents page, blank versos so chapters open on a recto, and book metadata", async () => {
  const done = await exportAndWait({
    kind: "pdf",
    pdf: { ...book, metadata: { subject: "Rain", keywords: ["manga", "noir"] } },
    acknowledgeIssues: true,
  });
  const pdf = await PDFDocument.load(await download(done.files[0]!.assetId));
  // contents(1) blank(2) One p1–p3(3–5) blank(6) Two p1–p2(7–8); a KDP interior carries no cover.
  expect(pdf.getPageCount()).toBe(8);
  const drawn = pdf
    .getPages()
    .map((p) => (p.node.Resources()?.lookupMaybe(PDFName.of("XObject"), PDFDict) ? "img" : "blank"));
  expect(drawn).toEqual(["img", "blank", "img", "img", "img", "blank", "img", "img"]);
  // Blank pages keep the book's trim: a verso is trimmed on its left.
  expect(pdf.getPage(1).getTrimBox()).toMatchObject({ x: 9, y: 9, width: 432, height: 648 });
  expect(pdf.getTitle()).toBe("Rooftop Nights");
  expect(pdf.getAuthor()).toBe("Jin Park");
  expect(pdf.getSubject()).toBe("Rain");
  expect(pdf.getKeywords()).toBe("manga, noir");
  expect(pdf.catalog.lookup(PDFName.of("Lang"), PDFHexString).decodeText()).toBe("en");
});

test("the print preflight measures the same interior: resolution, ink, safe area, fonts, parity", async () => {
  const done = await exportAndWait({ kind: "print_preflight", pdf: book, acknowledgeIssues: true });
  type Report = {
    pageCount: number;
    evenPageCount: boolean;
    lowestDpi: number;
    maxInkPct: number;
    mostShiftedPage: { pageId: string } | null;
    fonts: { family: string; uses: number; embedded: boolean }[];
    issues: { code: string; severity: string; message: string }[];
    pages: { page: number; kind: string; imageDpi?: number; artDpi?: number | null; inkPct?: number }[];
  };
  const report = done.result!.preflight as Report;
  expect(report.pageCount).toBe(8);
  expect(report.evenPageCount).toBe(true);
  expect(report.pages.map((p) => p.kind)).toEqual(["toc", "blank", "page", "page", "page", "blank", "page", "page"]);
  // 64 px of art across a 1.5" panel is about 40 DPI.
  const art = report.pages[2]!;
  expect(art.artDpi).toBeLessThan(100);
  expect(art.imageDpi).toBeGreaterThan(0);
  expect(art.inkPct).toBeGreaterThan(0);
  const codes = report.issues.map((i) => i.code);
  expect(codes).toEqual(expect.arrayContaining(["low_dpi", "text_outside_safe", "page_count_low", "fonts_rasterized"]));
  expect(codes).not.toContain("odd_page_count");
  expect(report.issues.find((i) => i.code === "text_outside_safe")!.message).toContain("page 3 ");
  expect(report.fonts[0]!.uses).toBe(1);
  expect(report.fonts[0]!.embedded).toBe(false);
  expect(report.mostShiftedPage).not.toBeNull();
  // The downloadable report is the same document.
  const file = JSON.parse(new TextDecoder().decode(await download(done.files[0]!.assetId)));
  expect(file.pages).toHaveLength(8);

  // The soft proof the report's viewer shows: the same page, through CMYK and back, at the same size.
  const plain = await alice.raw("GET", `/api/pages/${firstPages[0]}/render.png?width=400`);
  const proof = await alice.raw("GET", `/api/pages/${firstPages[0]}/render.png?width=400&proof=cmyk`);
  expect(proof.status).toBe(200);
  const [a, b] = await Promise.all([plain, proof].map(async (r) => sharp(await r.arrayBuffer()).metadata()));
  expect([b!.width, b!.height]).toEqual([a!.width, a!.height]);
  expect((await alice.raw("GET", `/api/pages/${firstPages[0]}/render.png?proof=sepia`)).status).toBe(422);
});

test("the print cover is checked before rendering, then rendered as back, spine and front with bleed", async () => {
  const q = "pageSize=kdp_6x9&paper=cream&toc=true&rectoChapters=true";
  type Check = {
    pageCount: number;
    layout: { spineIn: number; widthIn: number; artDpi: number; issues: { code: string }[] };
  };
  const thin = await alice.get<Check>(`/api/projects/${projectId}/print/cover?${q}`);
  expect(thin.pageCount).toBe(8);
  expect(thin.layout.spineIn).toBeCloseTo(0.02, 6);
  expect(thin.layout.artDpi).toBe(308);
  expect(thin.layout.issues.map((i) => i.code).sort()).toEqual(["page_count_low", "spine_no_text"]);
  const thick = await alice.get<Check>(`/api/projects/${projectId}/print/cover?${q}&pageCount=200`);
  expect(thick.layout.spineIn).toBeCloseTo(0.5, 6);
  expect(thick.layout.issues).toEqual([]);

  // Refused before queueing: no print size, or no cover art.
  await alice.post(`/api/projects/${projectId}/exports`, { kind: "print_cover", pdf: { pageSize: "source" } }, 400);
  await h.deps.db.update(projects).set({ coverAssetId: null }).where(eq(projects.id, projectId));
  await alice.post(`/api/projects/${projectId}/exports`, { kind: "print_cover", pdf: { pageSize: "kdp_6x9" } }, 400);
  await h.deps.db.update(projects).set({ coverAssetId }).where(eq(projects.id, projectId));

  const done = await exportAndWait({
    kind: "print_cover",
    pdf: { pageSize: "kdp_6x9", dpi: 150 },
    print: { paper: "cream", pageCount: 200 },
  });
  const cover = done.result!.cover as { spineIn: number; widthIn: number; heightIn: number; issues: unknown[] };
  expect(cover.spineIn).toBeCloseTo(0.5, 6);
  expect(cover.issues).toEqual([]);
  const pdfFile = done.files.find((f) => f.fileName.endsWith("_cover.pdf"))!;
  const page = (await PDFDocument.load(await download(pdfFile.assetId))).getPage(0);
  // 0.125" bleed + 6" back + 0.5" spine + 6" front + 0.125" bleed, by 9" + 0.25".
  expect(page.getWidth()).toBeCloseTo(12.75 * 72, 2);
  expect(page.getHeight()).toBeCloseTo(9.25 * 72, 2);
  expect(page.getTrimBox().x).toBeCloseTo(9, 2);
  const guides = done.files.find((f) => f.fileName.endsWith("_cover_guides.png"))!;
  expect((await sharp(await download(guides.assetId)).metadata()).width).toBe(1600);
});
