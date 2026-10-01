import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharp } from "@openmanga/image-utils";
import { PDFDocument } from "pdf-lib";
import { PdfWriter } from "./pdf.ts";

const png = async (width: number, height: number, channels: 3 | 4 = 3, noise = false) =>
  new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels,
        background: { r: 200, g: 40, b: 90, alpha: 0.5 },
        ...(noise ? { noise: { type: "gaussian" as const, mean: 128, sigma: 60 } } : {}),
      },
    })
      .png()
      .toBuffer(),
  );

test("PdfWriter writes pages a PDF reader opens, with their boxes, title and reading direction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-pdf-"));
  try {
    const path = join(dir, "out.pdf");
    const pdf = await PdfWriter.create(path, { title: "Ünïcode — title", rtl: true });
    await pdf.addPage({
      png: await png(60, 90),
      width: 300,
      height: 450,
      image: { x: 0, y: 0, width: 300, height: 450 },
    });
    const grey = new Uint8Array(
      await sharp({ create: { width: 40, height: 40, channels: 3, background: "#777" } })
        .toColourspace("b-w")
        .png()
        .toBuffer(),
    );
    await pdf.addPage({
      png: grey,
      width: 441,
      height: 666,
      image: { x: 0, y: 0, width: 441, height: 666 },
      trimBox: { x: 9, y: 9, width: 432, height: 648 },
      bleedBox: { x: 0, y: 0, width: 441, height: 666 },
    });
    // Transparency is flattened: a PDF image here carries no soft mask.
    await pdf.addPage({
      png: await png(20, 20, 4),
      width: 100,
      height: 100,
      image: { x: 10, y: 10, width: 80, height: 80 },
    });
    await pdf.close();

    const doc = await PDFDocument.load(await Bun.file(path).bytes());
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toBe("Ünïcode — title");
    expect(doc.getPage(0).getSize()).toEqual({ width: 300, height: 450 });
    expect(doc.getPage(1).getTrimBox()).toMatchObject({ x: 9, y: 9, width: 432, height: 648 });
    expect(doc.catalog.getViewerPreferences()?.getReadingDirection()).toBe("R2L" as never);
    expect(new TextDecoder().decode((await Bun.file(path).bytes()).slice(-6))).toBe("%%EOF\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("PdfWriter memory stays flat however many pages it writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-pdf-mem-"));
  try {
    // Noise does not compress: each page is ~3 MB of image data, so 40 pages held in memory would be ~120 MB.
    const page = await png(1000, 1000, 3, true);
    const pdf = await PdfWriter.create(join(dir, "big.pdf"), { title: "big", rtl: false });
    const add = () =>
      pdf.addPage({ png: page, width: 500, height: 500, image: { x: 0, y: 0, width: 500, height: 500 } });
    for (let i = 0; i < 5; i++) await add();
    Bun.gc(true);
    const before = process.memoryUsage.rss();
    for (let i = 0; i < 40; i++) await add();
    Bun.gc(true);
    const grown = process.memoryUsage.rss() - before;
    await pdf.close();
    expect(Bun.file(join(dir, "big.pdf")).size).toBeGreaterThan(40 * page.byteLength * 0.9);
    expect(grown).toBeLessThan(60 * 1024 * 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
