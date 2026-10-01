/** Comic-reader (CBZ) and fixed-layout EPUB 3 packaging. */
import { ZipWriter } from "./zip.ts";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

export type BookMeta = {
  id: string;
  title: string;
  series: string;
  number?: number;
  author: string;
  summary: string;
  language: string;
  rtl: boolean;
  blackAndWhite: boolean;
};

/** ComicInfo.xml (the ComicRack schema read by Komga, Kavita, CDisplayEx, Tachiyomi/Mihon…). */
export function comicInfoXml(m: BookMeta, pageCount: number) {
  const tag = (name: string, v: string | number | undefined) =>
    v === undefined || v === "" ? "" : `  <${name}>${esc(String(v))}</${name}>\n`;
  return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
${tag("Title", m.title)}${tag("Series", m.series)}${tag("Number", m.number)}${tag("Summary", m.summary)}${tag("Writer", m.author)}${tag("PageCount", pageCount)}${tag("LanguageISO", m.language)}${tag("Manga", m.rtl ? "YesAndRightToLeft" : "No")}${tag("BlackAndWhite", m.blackAndWhite ? "Yes" : "No")}</ComicInfo>
`;
}

export type EpubPage = { file: string; width: number; height: number };

/**
 * The text files of a fixed-layout EPUB 3: one XHTML page per image, each sized to its image, spine in reading
 * order with the book's page-progression direction. `pages[0]` is the cover when `hasCover`.
 */
export function epubFiles(m: BookMeta, pages: EpubPage[], hasCover: boolean, modified = new Date()) {
  const pad = (i: number) => String(i + 1).padStart(4, "0");
  const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>
`;
  const xhtml = (p: EpubPage, i: number) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(m.language)}">
<head><meta charset="UTF-8"/><title>${esc(m.title)} — ${i + 1}</title>
<meta name="viewport" content="width=${p.width}, height=${p.height}"/>
<style>html,body{margin:0;padding:0;width:${p.width}px;height:${p.height}px}img{display:block;width:${p.width}px;height:${p.height}px}</style></head>
<body><img src="images/${p.file}" alt="Page ${i + 1}"/></body>
</html>
`;
  const mime = (f: string) => (f.endsWith(".png") ? "image/png" : "image/jpeg");
  const manifest = pages
    .map(
      (p, i) =>
        `    <item id="img${pad(i)}" href="images/${p.file}" media-type="${mime(p.file)}"${hasCover && i === 0 ? ' properties="cover-image"' : ""}/>\n` +
        `    <item id="p${pad(i)}" href="p${pad(i)}.xhtml" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const spine = pages.map((_, i) => `    <itemref idref="p${pad(i)}"/>`).join("\n");
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${esc(m.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:${esc(m.id)}</dc:identifier>
    <dc:title>${esc(m.title)}</dc:title>
    <dc:language>${esc(m.language)}</dc:language>
${m.author ? `    <dc:creator>${esc(m.author)}</dc:creator>\n` : ""}${m.summary ? `    <dc:description>${esc(m.summary)}</dc:description>\n` : ""}    <meta property="dcterms:modified">${modified.toISOString().replace(/\.\d{3}Z$/, "Z")}</meta>
    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">landscape</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifest}
  </manifest>
  <spine page-progression-direction="${m.rtl ? "rtl" : "ltr"}">
${spine}
  </spine>
</package>
`;
  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${esc(m.language)}">
<head><meta charset="UTF-8"/><title>${esc(m.title)}</title></head>
<body><nav epub:type="toc"><ol><li><a href="p${pad(0)}.xhtml">${esc(m.title)}</a></li></ol></nav></body>
</html>
`;
  return [
    { name: "META-INF/container.xml", text: container },
    { name: "OEBPS/content.opf", text: opf },
    { name: "OEBPS/nav.xhtml", text: nav },
    ...pages.map((p, i) => ({ name: `OEBPS/p${pad(i)}.xhtml`, text: xhtml(p, i) })),
  ];
}

export type BookImage = { data: Uint8Array; width: number; height: number };

/**
 * Writes a CBZ or an EPUB to `path`, adding each JPEG page to the archive as `pages` yields it, so memory holds one
 * page however long the book. Only page sizes are kept: the EPUB's manifest, spine and page files are written from
 * them after the images. Readers do not care about entry order, except that an EPUB's `mimetype` comes first,
 * stored (ZipWriter never compresses) and with no extra field.
 */
export async function writeBook(
  kind: "cbz" | "epub",
  path: string,
  meta: BookMeta,
  pages: AsyncIterable<BookImage>,
  /** EPUB only: shown as the book's cover image. */
  cover?: BookImage,
) {
  const zip = new ZipWriter(path);
  const enc = new TextEncoder();
  const sizes: EpubPage[] = [];
  const add = async (file: string, im: BookImage) => {
    await zip.add(kind === "epub" ? `OEBPS/images/${file}` : file, im.data);
    sizes.push({ file, width: im.width, height: im.height });
  };
  if (kind === "epub") {
    await zip.add("mimetype", enc.encode("application/epub+zip"));
    if (cover) await add("cover.jpg", cover);
  }
  let n = 0;
  for await (const im of pages) await add(`${String(++n).padStart(4, "0")}.jpg`, im);
  if (kind === "cbz") await zip.add("ComicInfo.xml", enc.encode(comicInfoXml(meta, n)));
  else for (const f of epubFiles(meta, sizes, Boolean(cover))) await zip.add(f.name, enc.encode(f.text));
  return zip.close();
}
