import { expect, test } from "bun:test";
import { comicInfoXml, epubFiles } from "./ebook.ts";

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
