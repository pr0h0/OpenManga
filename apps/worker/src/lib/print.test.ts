import { expect, test } from "bun:test";
import { coverLayout } from "@openmanga/domain";
import { sharp } from "@openmanga/image-utils";
import { coverGuides, fontReport, installedFonts, panelArtDpi, renderPrintCover, renderTocPage } from "./print.ts";

// Measuring drawn text needs the render image's face (CI installs it too); elsewhere a fallback face draws wider.
const hasFace = (await installedFonts())?.has("dejavu sans") ?? false;

const art = async (width: number, height: number) =>
  new Uint8Array(
    await sharp({ create: { width, height, channels: 3, background: "#2a6f97" } })
      .png()
      .toBuffer(),
  );

const layout = () =>
  coverLayout({
    trimIn: [5, 8],
    pageCount: 120,
    paper: "cream",
    art: { width: 600, height: 900 },
    title: "The Rooftop",
    author: "Jin Park",
    description: "Rain hammered the city as Woo Jin climbed onto the rooftop. ".repeat(9),
  });

test.skipIf(!hasFace)("the cover renders at its print size with every text block inside the safe areas", async () => {
  const l = layout();
  const out = await renderPrintCover(l, await art(600, 900), 100);
  expect(out.width).toBe(Math.round(l.widthIn * 100));
  expect(out.height).toBe(Math.round(l.heightIn * 100));
  expect(out.issues).toEqual([]);
  const meta = await sharp(out.png).metadata();
  expect([meta.width, meta.height]).toEqual([out.width, out.height]);
  const guides = await coverGuides(out.png, l, 800);
  expect((await sharp(guides).metadata()).width).toBe(800);
});

test("measuring the drawn text catches a block pushed past the trim", async () => {
  const l = layout();
  const title = l.text.find((t) => t.role === "title")!;
  title.x = l.panels.front.x + l.panels.front.width; // centred on the outside edge: half of it is in the bleed
  const out = await renderPrintCover(l, await art(600, 900), 100);
  expect(out.issues.map((i) => i.code)).toEqual(["text_outside_safe"]);
});

test("panel art resolution where it prints: the crop's pixels over the panel's printed width", () => {
  // A half-width panel of a page printed 6" wide is 3" wide: 1500 px of art across it is 500 DPI.
  const frame = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const t = { focalX: 0.5, focalY: 0.5, scale: 1 };
  expect(panelArtDpi({ width: 1500, height: 1500 }, frame, t, { width: 1000, height: 1000 }, 6)).toBe(500);
  // Zooming in 2× keeps half the pixels.
  expect(panelArtDpi({ width: 1500, height: 1500 }, frame, { ...t, scale: 2 }, { width: 1000, height: 1000 }, 6)).toBe(
    250,
  );
});

test("the font report: most-used first, installed or not, never embedded because lettering is pixels", () => {
  const rows = fontReport(
    new Map([
      ["Comic Neue", 3],
      ["Bangers", 5],
    ]),
    new Set(["comic neue", "dejavu sans"]),
  );
  expect(rows.map((r) => [r.family, r.installed, r.embedded])).toEqual([
    ["Bangers", false, false],
    ["Comic Neue", true, false],
  ]);
  expect(fontReport(new Map([["X", 1]]), null)[0]!.installed).toBeNull();
});

test("a contents page is drawn at the interior page size", async () => {
  const png = await renderTocPage([{ order: 1, title: "A very long chapter title ".repeat(6), page: 3 }], 800, 1200);
  const meta = await sharp(png).metadata();
  expect([meta.width, meta.height]).toEqual([800, 1200]);
});
