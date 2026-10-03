import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sharp } from "@openmanga/image-utils";
import { unzipSync } from "fflate";
import { type BookImage, comicInfoXml, epubFiles, writeBook } from "./ebook.ts";

const meta = {
  id: "7f3c1c1e-0000-4000-8000-000000000001",
  title: "Rain & <Steel>",
  series: "Rain",
  number: 2,
  author: "",
  summary: "",
  language: "en",
  rtl: true,
  blackAndWhite: false,
};

test("ComicInfo carries the series, number, direction and escapes text; empty fields are left out", () => {
  const xml = comicInfoXml(meta, 3);
  expect(xml).toContain("<Title>Rain &amp; &lt;Steel&gt;</Title>");
  expect(xml).toContain("<Number>2</Number>");
  expect(xml).toContain("<Manga>YesAndRightToLeft</Manga>");
  expect(xml).toContain("<PageCount>3</PageCount>");
  expect(xml).not.toContain("<Writer>");
});

test("a fixed-layout EPUB sizes each page to its image, marks the cover and reads in the book's direction", () => {
  const files = epubFiles(
    meta,
    [
      { file: "cover.jpg", width: 1200, height: 1800 },
      { file: "0001.jpg", width: 1000, height: 1500 },
    ],
    true,
  );
  const byName = Object.fromEntries(files.map((f) => [f.name, f.text]));
  const opf = byName["OEBPS/content.opf"]!;
  expect(opf).toContain('<meta property="rendition:layout">pre-paginated</meta>');
  expect(opf).toContain('page-progression-direction="rtl"');
  expect(opf).toContain('href="images/cover.jpg" media-type="image/jpeg" properties="cover-image"');
  expect(opf).not.toContain('0001.jpg" media-type="image/jpeg" properties');
  expect(opf).toMatch(/dcterms:modified">\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ</);
  expect(byName["OEBPS/p0002.xhtml"]).toContain('content="width=1000, height=1500"');
  expect(byName["META-INF/container.xml"]).toContain("OEBPS/content.opf");
});

const jpeg = async (width: number, height: number, noise = false): Promise<BookImage> => ({
  data: new Uint8Array(
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: "#c83c5a",
        ...(noise ? { noise: { type: "gaussian" as const, mean: 128, sigma: 60 } } : {}),
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer(),
  ),
  width,
  height,
});

async function* yieldAll(images: BookImage[]) {
  for (const im of images) yield im;
}

const unzipTest = (path: string) => {
  if (Bun.which("unzip")) expect(Bun.spawnSync(["unzip", "-tqq", path]).exitCode).toBe(0);
};

test("a streamed EPUB holds together: mimetype first and stored, container, manifest, spine and every page", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-epub-"));
  try {
    const pages = [await jpeg(100, 150), await jpeg(120, 180), await jpeg(100, 150)];
    const path = await writeBook("epub", join(dir, "b.epub"), meta, yieldAll(pages), await jpeg(80, 120));
    const buf = await Bun.file(path).bytes();
    const v = new DataView(buf.buffer);
    // OCF: the first local header is `mimetype`, method 0 (stored), no extra field, the media type as its data.
    expect(v.getUint32(0, true)).toBe(0x04034b50);
    expect(v.getUint16(8, true)).toBe(0);
    expect(v.getUint16(28, true)).toBe(0);
    expect(new TextDecoder().decode(buf.slice(30, 38))).toBe("mimetype");
    expect(new TextDecoder().decode(buf.slice(38, 58))).toBe("application/epub+zip");
    unzipTest(path);

    const files = unzipSync(buf);
    const text = (name: string) => new TextDecoder().decode(files[name]);
    const opfPath = text("META-INF/container.xml").match(/full-path="([^"]+)"/)![1]!;
    const opf = text(opfPath);
    const items = [...opf.matchAll(/<item id="([^"]+)" href="([^"]+)"/g)].map((m) => ({ id: m[1]!, href: m[2]! }));
    // Every manifest item exists in the archive, and nothing in OEBPS is left out of the manifest.
    for (const it of items) expect(files[`OEBPS/${it.href}`]).toBeDefined();
    const listed = new Set(items.map((it) => `OEBPS/${it.href}`));
    for (const name of Object.keys(files).filter((n) => n.startsWith("OEBPS/") && n !== opfPath))
      expect(listed.has(name)).toBe(true);
    // Spine: the cover plus each page, in order, each pointing at a manifest XHTML page whose image is present.
    const spine = [...opf.matchAll(/<itemref idref="([^"]+)"/g)].map((m) => m[1]!);
    expect(spine.length).toBe(pages.length + 1);
    for (const [i, idref] of spine.entries()) {
      const page = items.find((it) => it.id === idref)!;
      const img = text(`OEBPS/${page.href}`).match(/<img src="([^"]+)"/)![1]!;
      expect(files[`OEBPS/${img}`]).toBeDefined();
      expect(img).toBe(i === 0 ? "images/cover.jpg" : `images/${String(i).padStart(4, "0")}.jpg`);
    }
    expect(text("OEBPS/p0003.xhtml")).toContain('content="width=120, height=180"');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a streamed CBZ has every page in order and a ComicInfo page count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-cbz-"));
  try {
    const pages = [await jpeg(50, 70), await jpeg(50, 70)];
    const path = await writeBook("cbz", join(dir, "b.cbz"), meta, yieldAll(pages));
    unzipTest(path);
    const files = unzipSync(await Bun.file(path).bytes());
    expect(Object.keys(files)).toEqual(["0001.jpg", "0002.jpg", "ComicInfo.xml"]);
    expect(Buffer.from(files["0002.jpg"]!).equals(Buffer.from(pages[1]!.data))).toBe(true);
    expect(new TextDecoder().decode(files["ComicInfo.xml"])).toContain("<PageCount>2</PageCount>");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("writeBook memory stays flat however many pages it writes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-epub-mem-"));
  try {
    // Noise defeats JPEG compression: ~1.7 MB a page, so 100 pages held in memory would be ~170 MB.
    const page = await jpeg(1500, 1500, true);
    let before = 0;
    async function* pages() {
      for (let i = 0; i < 105; i++) {
        if (i === 5) {
          Bun.gc(true);
          before = process.memoryUsage.rss();
        }
        // A fresh copy each time, as a renderer hands over: keeping any of them would show.
        yield { ...page, data: page.data.slice() };
      }
    }
    const path = await writeBook("epub", join(dir, "big.epub"), meta, pages());
    Bun.gc(true);
    const grown = process.memoryUsage.rss() - before;
    expect(Bun.file(path).size).toBeGreaterThan(105 * page.data.byteLength);
    expect(grown).toBeLessThan(70 * 1024 * 1024);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
