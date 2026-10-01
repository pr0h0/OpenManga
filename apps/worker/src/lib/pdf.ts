import { type FileHandle, open } from "node:fs/promises";
import { sharp } from "@openmanga/image-utils";

/** A box in points, PDF-style: x and y from the bottom-left corner. */
export type Box = { x: number; y: number; width: number; height: number };

export type ImagePage = {
  /** Any PNG; transparency is flattened onto white. */
  png: Uint8Array;
  width: number;
  height: number;
  /** Where the image is drawn on the page. */
  image: Box;
  trimBox?: Box;
  bleedBox?: Box;
};

/**
 * Writes a PDF of full-page images straight to disk, one page at a time, so memory holds one page however many
 * there are (pdf-lib keeps every embedded image until `save()` returns the whole file as one buffer). Each page's
 * PNG goes in as its own compressed pixel data, a FlateDecode stream with the PNG predictor, so the art stays
 * lossless and is not compressed a second time.
 */
export class PdfWriter {
  private offset = 0;
  /** Byte offset of each object, by object number; 1 is the catalog and 2 the page tree, both written at the end. */
  private readonly offsets: number[] = [0, 0, 0];
  private readonly pages: number[] = [];

  private constructor(
    private readonly file: FileHandle,
    private readonly meta: { title: string; rtl: boolean },
  ) {}

  static async create(path: string, meta: { title: string; rtl: boolean }) {
    const w = new PdfWriter(await open(path, "w"), meta);
    // The binary comment marks the file as binary for transfer tools, as the spec recommends.
    await w.write(new Uint8Array([...ascii("%PDF-1.7\n%"), 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    return w;
  }

  async addPage(p: ImagePage) {
    const img = await pngPixels(p.png);
    const colors = img.colorType === 2 ? 3 : 1;
    const image = await this.object(
      `<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /${colors === 3 ? "DeviceRGB" : "DeviceGray"} /BitsPerComponent ${img.bitDepth} /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${img.bitDepth} /Columns ${img.width} >> /Length ${img.byteLength} >>`,
      img.data,
    );
    const b = p.image;
    const draw = ascii(`q ${num(b.width)} 0 0 ${num(b.height)} ${num(b.x)} ${num(b.y)} cm /Im0 Do Q`);
    const content = await this.object(`<< /Length ${draw.byteLength} >>`, [draw]);
    const box = (name: string, r?: Box) =>
      r ? ` /${name} [${num(r.x)} ${num(r.y)} ${num(r.x + r.width)} ${num(r.y + r.height)}]` : "";
    this.pages.push(
      await this.object(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(p.width)} ${num(p.height)}]${box("TrimBox", p.trimBox)}${box("BleedBox", p.bleedBox)} /Resources << /XObject << /Im0 ${image} 0 R >> >> /Contents ${content} 0 R >>`,
      ),
    );
  }

  /** Writes the page tree, catalog, document info and cross-reference table, then closes the file. */
  async close() {
    await this.object(
      `<< /Type /Pages /Kids [${this.pages.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pages.length} >>`,
      undefined,
      2,
    );
    const prefs = this.meta.rtl ? " /ViewerPreferences << /Direction /R2L >>" : "";
    await this.object(`<< /Type /Catalog /Pages 2 0 R${prefs} >>`, undefined, 1);
    const now = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const info = await this.object(
      `<< /Title ${pdfText(this.meta.title)} /Creator (OpenManga) /Producer (OpenManga) /CreationDate (D:${now}Z) >>`,
    );
    const xref = this.offset;
    const rows = this.offsets.slice(1).map((o) => `${String(o).padStart(10, "0")} 00000 n \n`);
    await this.write(
      ascii(
        `xref\n0 ${this.offsets.length}\n0000000000 65535 f \n${rows.join("")}trailer\n<< /Size ${this.offsets.length} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`,
      ),
    );
    await this.file.close();
  }

  /** Writes one indirect object (a stream when `data` is given) and returns its number. */
  private async object(dict: string, data?: Uint8Array[], id = this.offsets.length) {
    this.offsets[id] = this.offset;
    if (!data) {
      await this.write(ascii(`${id} 0 obj\n${dict}\nendobj\n`));
      return id;
    }
    await this.write(ascii(`${id} 0 obj\n${dict}\nstream\n`));
    for (const d of data) await this.write(d);
    await this.write(ascii("\nendstream\nendobj\n"));
    return id;
  }

  private async write(data: Uint8Array) {
    for (let done = 0; done < data.byteLength; ) {
      const { bytesWritten } = await this.file.write(data, done, data.byteLength - done, this.offset);
      done += bytesWritten;
      this.offset += bytesWritten;
    }
  }
}

const ascii = (s: string) => new TextEncoder().encode(s);
/** Fixed-point: PDF has no exponent notation. */
const num = (v: number) => String(Math.round(v * 1000) / 1000);
/** A text string as UTF-16BE hex with a byte-order mark, so any title survives without escaping rules. */
function pdfText(s: string) {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

/**
 * The image's zlib-compressed scanlines, straight from its IDAT chunks. The PNG is first re-encoded as
 * non-interlaced RGB or grey without alpha or a palette, which is exactly what a PDF FlateDecode image with the PNG
 * predictor reads.
 */
async function pngPixels(png: Uint8Array) {
  const clean = await sharp(png, { limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .png({ palette: false, progressive: false, compressionLevel: 6 })
    .toBuffer();
  const v = new DataView(clean.buffer, clean.byteOffset, clean.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const data: Uint8Array[] = [];
  let byteLength = 0;
  while (at < clean.byteLength) {
    const len = v.getUint32(at);
    const type = String.fromCharCode(...clean.subarray(at + 4, at + 8));
    const body = clean.subarray(at + 8, at + 8 + len);
    if (type === "IHDR") {
      width = v.getUint32(at + 8);
      height = v.getUint32(at + 12);
      bitDepth = body[8]!;
      colorType = body[9]!;
      if (body[12] !== 0) throw new Error("Interlaced PNG cannot be embedded");
    } else if (type === "IDAT") {
      data.push(body);
      byteLength += len;
    } else if (type === "IEND") break;
    at += 12 + len;
  }
  if (colorType !== 0 && colorType !== 2) throw new Error(`Unexpected PNG colour type ${colorType}`);
  return { width, height, bitDepth, colorType, data, byteLength };
}
