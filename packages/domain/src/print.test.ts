import { expect, test } from "bun:test";
import { coverLayout, gutterIn, interiorSequence, outsideSafeZone, spineWidthIn, trimSizeIn } from "./print.ts";

const base = {
  trimIn: [6, 9] as [number, number],
  pageCount: 200,
  paper: "white" as const,
  art: { width: 1200, height: 1800 },
  title: "The Rooftop",
  author: "Jin Park",
  description: "Rain hammered the city as Woo Jin climbed onto the rooftop.",
};

test("trim sizes: KDP trims in inches, other sizes from points, none for source", () => {
  expect(trimSizeIn("kdp_6x9")).toEqual([6, 9]);
  expect(trimSizeIn("letter")).toEqual([8.5, 11]);
  expect(trimSizeIn("source")).toBeNull();
});

test("the spine is the page count times KDP's paper thickness, or a custom thickness", () => {
  expect(spineWidthIn(200, "white")).toBeCloseTo(0.4504, 4);
  expect(spineWidthIn(200, "cream")).toBeCloseTo(0.5, 4);
  expect(spineWidthIn(100, "white", 0.1)).toBeCloseTo(100 * (0.1 / 25.4), 6);
});

test("a cover is back + spine + front with bleed, and its text sits inside the safe areas", () => {
  const c = coverLayout(base);
  expect(c.widthIn).toBeCloseTo(0.25 + 12 + 0.4504, 4);
  expect(c.heightIn).toBe(9.25);
  expect(c.panels.front.x).toBeCloseTo(0.125 + 6 + 0.4504, 4);
  expect(c.artDpi).toBe(Math.round(Math.min(1200 / 6.125, 1800 / 9.25)));
  expect(c.issues.map((i) => i.code)).toEqual(["art_low_dpi"]);
  // The barcode box is on the back, clear of the spine and the bottom trim.
  expect(c.barcode.x + c.barcode.width).toBeCloseTo(c.panels.back.x + 6 - 0.25, 6);
  expect(c.text.map((t) => t.role)).toEqual(["title", "author", "spine", "back"]);
  const spine = c.text.find((t) => t.role === "spine")!;
  expect(spine.rotate).toBe(90);
  expect(spine.lines[0]).toContain("Jin Park");
  const back = c.text.find((t) => t.role === "back")!;
  expect(back.x).toBeGreaterThanOrEqual(c.safe.back.x);
  expect(back.y + back.lines.length * back.lineIn).toBeLessThan(c.barcode.y);
});

test("a right-to-left book's cover is mirrored: front on the left, barcode next to the spine", () => {
  const c = coverLayout({ ...base, rtl: true });
  expect(c.panels.front.x).toBe(0.125);
  expect(c.frontArt.x).toBe(0);
  expect(c.panels.back.x).toBeCloseTo(0.125 + 6 + c.spineIn, 6);
  expect(c.barcode.x).toBeCloseTo(c.panels.back.x + 0.25, 6);
  expect(c.text.find((t) => t.role === "title")!.x).toBeCloseTo(0.125 + 3, 6);
});

test("cover checks: thin books get no spine text, missing art blocks, sharp art passes, long text is cut", () => {
  const thin = coverLayout({ ...base, pageCount: 60 });
  expect(thin.issues.map((i) => i.code)).toContain("spine_no_text");
  expect(thin.text.some((t) => t.role === "spine")).toBe(false);

  const noArt = coverLayout({ ...base, art: null });
  expect(noArt.issues.find((i) => i.code === "no_cover_art")?.severity).toBe("block");

  const sharp = coverLayout({ ...base, art: { width: 1900, height: 2800 } });
  expect(sharp.issues.some((i) => i.code === "art_low_dpi")).toBe(false);

  const long = coverLayout({ ...base, description: "word ".repeat(2000), pageCount: 20 });
  expect(long.issues.map((i) => i.code)).toEqual(expect.arrayContaining(["back_text_cut", "page_count_low"]));
  const back = long.text.find((t) => t.role === "back")!;
  expect(back.sizePt).toBe(8);
  expect(back.lines.at(-1)).toEndWith("…");
});

test("the interior: contents page, blank versos before chapters, and page numbers for the contents", () => {
  const chapters = [
    { id: "a", title: "One", order: 1, pageIds: ["a1", "a2", "a3"] },
    { id: "b", title: "Two", order: 2, pageIds: ["b1", "b2"] },
    { id: "c", title: "Empty", order: 3, pageIds: [] },
    { id: "d", title: "Three", order: 4, pageIds: ["d1"] },
  ];
  const plain = interiorSequence(chapters, { cover: false, toc: false, rectoChapters: false });
  expect(plain.entries.map((e) => e.kind).join()).toBe("page,page,page,page,page,page");
  const book = interiorSequence(chapters, { cover: false, toc: true, rectoChapters: true });
  // toc(1) blank(2) a1..a3(3-5) blank(6) b1 b2(7-8) d1(9)
  expect(book.entries.map((e) => (e.kind === "page" ? e.pageId : e.kind)).join()).toBe(
    "toc,blank,a1,a2,a3,blank,b1,b2,d1",
  );
  expect(book.toc).toEqual([
    { order: 1, title: "One", page: 3 },
    { order: 2, title: "Two", page: 7 },
    { order: 4, title: "Three", page: 9 },
  ]);
  for (const t of book.toc) expect(t.page % 2).toBe(1);
});

test("interior lettering outside the safe zone: KDP's gutter grows with the page count and follows the binding", () => {
  // A 6x9 KDP page with bleed, art filling it; the trim of a recto starts at the binding (left).
  const image = { x: 0, y: 0, width: 441, height: 666 };
  const trim = { x: 0, y: 9, width: 432, height: 648 };
  const nearLeft = { id: "l", x: 0.08, y: 0.4, width: 0.2, height: 0.1 };
  const centre = { id: "c", x: 0.4, y: 0.4, width: 0.2, height: 0.1 };
  const nearTop = { id: "t", x: 0.4, y: 0.01, width: 0.2, height: 0.1 };
  const place = { image, trim, kdp: true, pageCount: 400, index: 0, rtl: false };
  expect(outsideSafeZone([nearLeft, centre, nearTop], place).map((b) => b.id)).toEqual(["l", "t"]);
  // On a verso the binding is on the right, so the same box on the left only needs the outside margin.
  expect(outsideSafeZone([nearLeft], { ...place, index: 1, trim: { ...trim, x: 9 } })).toEqual([]);
  expect(gutterIn(100)).toBe(0.375);
  expect(gutterIn(400)).toBe(0.625);
  expect(gutterIn(800)).toBe(0.875);
});
