import { afterAll, beforeAll, expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { mockImagePng } from "@openmanga/testing";
import { initializeCanvas, type Layer, readPsd } from "ag-psd";
import { unzipSync } from "fflate";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

// ag-psd reads the PSDs back as an independent check; outside a browser it needs an ImageData factory.
initializeCanvas(
  (() => {
    throw new Error("no canvas");
  }) as never,
  ((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })) as never,
);

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let chapterId: string;

type Job = { id: string; status: string; failureReason: string | null; files: { assetId: string; fileName: string }[] };
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
const upload = (data: Uint8Array) => {
  const f = new FormData();
  f.set("file", new File([data as BlobPart], "art.png", { type: "image/png" }));
  return f;
};

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "finisher", email: "fi@example.com", password: "finish-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Layer Cake" }, 201);
  projectId = p.project.id;
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  chapterId = ch.chapter.id;
  for (let i = 0; i < 2; i++) {
    const page = await alice.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "four-grid" },
      201,
    );
    const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
    for (const panel of doc.panels) {
      const png = await mockImagePng({ width: 128, height: 128, prompt: `${i} ${panel.id}` });
      expect((await alice.raw("POST", `/api/panels/${panel.id}/artwork/upload`, upload(png))).status).toBe(201);
    }
    if (i === 0) {
      await alice.post(
        `/api/pages/${page.page.id}/dialogue`,
        { panelId: doc.panels[0]!.id, text: "Who's there?" },
        201,
      );
      await alice.post(`/api/pages/${page.page.id}/dialogue`, { text: "Later that night.", type: "narration" }, 201);
      await alice.post(`/api/pages/${page.page.id}/sfx`, { panelId: doc.panels[1]!.id, text: "BAM" }, 201);
      // A layout guide on the first panel: the PSD keeps it as a hidden layer.
      const guide = new Uint8Array(
        await sharp({ create: { width: 64, height: 64, channels: 3, background: "#888888" } })
          .png()
          .toBuffer(),
      );
      expect((await alice.raw("POST", `/api/panels/${doc.panels[0]!.id}/guide`, upload(guide))).status).toBe(201);
    }
  }
}, 120_000);
afterAll(() => h?.stop());

test("layered PSDs: one per page, with panel groups, the hidden guide and every lettering element as a layer", async () => {
  const done = await exportAndWait({ kind: "psd_pages", chapterId, scale: 0.5 });
  const zip = unzipSync(await download(done.files[0]!.assetId));
  const names = Object.keys(zip).sort();
  expect(names).toEqual([expect.stringMatching(/_p001\.psd$/), expect.stringMatching(/_p002\.psd$/)]);
  const doc = readPsd(zip[names[0]!]!.buffer as ArrayBuffer, { useImageData: true });
  const [pageW, pageH] = [doc.width, doc.height];
  expect(pageW).toBeGreaterThan(100);
  const tree = (ls: Layer[] = []): unknown[] => ls.map((l) => (l.children ? [l.name, tree(l.children)] : l.name));
  const t = tree(doc.children);
  expect(t[0]).toBe("Background");
  const [, groupPanels, ...lettering] = t as [string, [string, unknown[]], ...[string, string[]][]];
  expect(groupPanels[0]).toBe("Panels");
  expect(groupPanels[1]).toHaveLength(4);
  expect(groupPanels[1][0]).toEqual(["Panel 1", ["Layout guide", "Art", "Frame"]]);
  expect(groupPanels[1][1]).toEqual(["Panel 2", ["Art", "Frame"]]);
  expect(lettering).toEqual([
    ["Effects", ["BAM"]],
    ["Captions", ["Later that night."]],
    ["Dialogue", ["Who's there?"]],
  ]);
  const panel1 = doc.children![1]!.children![0]!;
  const [guide, art] = panel1.children!;
  expect(guide!.hidden).toBe(true);
  // Every layer lies on the page, and the art fills its panel box with opaque pixels.
  const all = (ls: Layer[] = []): Layer[] => ls.flatMap((l) => (l.children ? all(l.children) : [l]));
  for (const l of all(doc.children)) {
    expect(l.left!).toBeGreaterThanOrEqual(0);
    expect(l.top!).toBeGreaterThanOrEqual(0);
    expect(l.right!).toBeLessThanOrEqual(pageW);
    expect(l.bottom!).toBeLessThanOrEqual(pageH);
  }
  expect(art!.imageData!.data[3]).toBe(255);
  expect(art!.right! - art!.left!).toBeGreaterThan(20);
  // The flattened image is the lettered page.
  expect(doc.imageData!.width).toBe(pageW);
});

test("separated art and lettering: text-free pages, SVG lettering and every layer placed by the manifest", async () => {
  const done = await exportAndWait({ kind: "layered_package", chapterId, scale: 0.5 });
  const files = unzipSync(await download(done.files[0]!.assetId));
  type Placed = { z: number; kind: string; file: string; x: number; y: number; width: number; height: number };
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]!)) as {
    format: string;
    pages: {
      folder: string;
      width: number;
      height: number;
      textFree: string;
      lettering: string;
      layers: (Placed & { text?: string; svgId?: string; panel?: number; hidden?: boolean })[];
    }[];
  };
  expect(manifest.format).toBe("openmanga-layers");
  expect(manifest.pages.map((p) => p.folder)).toEqual(["p001", "p002"]);
  const first = manifest.pages[0]!;
  expect(first.layers.map((l) => l.kind)).toEqual([
    "guide",
    "art",
    "frame",
    ...["art", "frame", "art", "frame", "art", "frame"],
    "sfx",
    "dialogue",
    "narration",
  ]);
  expect(first.layers.map((l) => l.z)).toEqual(first.layers.map((_, i) => i));
  for (const l of first.layers) {
    const img = await sharp(files[l.file]!).metadata();
    expect([img.width, img.height]).toEqual([l.width, l.height]);
    expect(l.x + l.width).toBeLessThanOrEqual(first.width);
    expect(l.y + l.height).toBeLessThanOrEqual(first.height);
  }
  const bubble = first.layers.find((l) => l.kind === "dialogue")!;
  expect(bubble.text).toBe("Who's there?");
  const svg = new TextDecoder().decode(files[first.lettering]!);
  expect(svg).toContain(`<g id="${bubble.svgId}">`);
  expect(svg).toContain("BAM");
  expect(svg).not.toContain("<image");
  // The text-free page is the page without its lettering: it differs from the lettered page where the bubble sits.
  const crop = (png: Uint8Array) =>
    sharp(png).extract({ left: bubble.x, top: bubble.y, width: bubble.width, height: bubble.height }).raw().toBuffer();
  const [lettered, clean] = await Promise.all([crop(files["p001/page.png"]!), crop(files[first.textFree]!)]);
  expect(Buffer.compare(lettered, clean)).not.toBe(0);
  // The second page has no lettering at all.
  expect(manifest.pages[1]!.layers.every((l) => l.kind === "art" || l.kind === "frame")).toBe(true);
});
