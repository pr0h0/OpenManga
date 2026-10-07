/**
 * A minimal Photoshop (PSD, version 1) writer: 8-bit RGB, raster layers with names, positions, opacity and
 * visibility, nested groups, PackBits (RLE) channel data, and the flattened composite readers that ignore layers show.
 * It writes what a lettering hand-off needs and nothing more: no masks, effects, text layers or smart objects.
 */

/** One raster layer: `rgba` is `width`×`height`×4, placed at `left`/`top` on the canvas. */
export type PsdLayer = {
  name: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rgba: Uint8Array;
  /** 0–1. */
  opacity?: number;
  hidden?: boolean;
};
/** A layer group; `children` run bottom to top, like the document's layers. */
export type PsdGroup = { name: string; children: PsdNode[]; hidden?: boolean };
export type PsdNode = PsdLayer | PsdGroup;

export type PsdDocument = {
  width: number;
  height: number;
  /** Written as the document resolution, pixels per inch. */
  dpi?: number;
  /** Bottom to top. */
  layers: PsdNode[];
  /** The flattened image, `width`×`height`×3 RGB. */
  composite: Uint8Array;
};

class Out {
  chunks: Uint8Array[] = [];
  length = 0;
  bytes(b: Uint8Array) {
    this.chunks.push(b);
    this.length += b.byteLength;
  }
  u8(v: number) {
    this.bytes(Uint8Array.of(v & 0xff));
  }
  u16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v);
    this.bytes(b);
  }
  i16(v: number) {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setInt16(0, v);
    this.bytes(b);
  }
  u32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v);
    this.bytes(b);
  }
  i32(v: number) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v);
    this.bytes(b);
  }
  ascii(s: string) {
    this.bytes(new TextEncoder().encode(s));
  }
  /** A section prefixed with its u32 length, padded with zeros to a multiple of `pad`. */
  section(build: (o: Out) => void, pad = 1) {
    const inner = new Out();
    build(inner);
    while (inner.length % pad) inner.u8(0);
    this.u32(inner.length);
    for (const c of inner.chunks) this.bytes(c);
  }
  concat() {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }
}

/** PackBits, the RLE Photoshop uses: runs of 2–128 equal bytes, literals of 1–128. */
export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run > 1) {
      out.push(257 - run, row[i]!);
      i += run;
      continue;
    }
    const start = i;
    while (i < row.length && i - start < 128 && !(i + 1 < row.length && row[i] === row[i + 1])) i++;
    out.push(i - start - 1);
    for (let k = start; k < i; k++) out.push(row[k]!);
  }
  return Uint8Array.from(out);
}

/** One channel of interleaved pixels, PackBits-compressed by row: the row byte counts, then the rows. */
function rleChannel(px: Uint8Array, width: number, height: number, stride: number, offset: number) {
  const rows: Uint8Array[] = [];
  const row = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) row[x] = px[(y * width + x) * stride + offset]!;
    rows.push(packBits(row));
  }
  return rows;
}

const isGroup = (n: PsdNode): n is PsdGroup => "children" in n;

/** Layer records run bottom to top; a group is its closing divider, its children, then the folder itself. */
function flatten(nodes: PsdNode[], out: ({ layer: PsdLayer } | { group: PsdGroup; divider: boolean })[] = []) {
  for (const n of nodes) {
    if (isGroup(n)) {
      out.push({ group: n, divider: true });
      flatten(n.children, out);
      out.push({ group: n, divider: false });
    } else out.push({ layer: n });
  }
  return out;
}

/** Pascal string padded so the length byte and text take a multiple of `pad` bytes. */
function pascal(o: Out, s: string, pad: number) {
  const b = new TextEncoder().encode(s.replace(/[^\x20-\x7e]/g, "?")).subarray(0, 255);
  o.u8(b.length);
  o.bytes(b);
  for (let n = 1 + b.length; n % pad; n++) o.u8(0);
}

function extra(o: Out, key: string, build: (o: Out) => void) {
  o.ascii("8BIM");
  o.ascii(key);
  o.section(build, 2);
}

export function writePsd(doc: PsdDocument): Uint8Array {
  const { width, height } = doc;
  const o = new Out();
  // Header: signature, version 1, 6 reserved bytes, 3 channels, size, 8 bits, RGB.
  o.ascii("8BPS");
  o.u16(1);
  o.bytes(new Uint8Array(6));
  o.u16(3);
  o.u32(height);
  o.u32(width);
  o.u16(8);
  o.u16(3);
  o.u32(0); // colour mode data
  o.section((r) => {
    if (!doc.dpi) return;
    // ResolutionInfo (0x03ED): 16.16 fixed pixels per inch, horizontally and vertically.
    r.ascii("8BIM");
    r.u16(0x03ed);
    r.u16(0); // empty name, padded to even
    r.u32(16);
    for (let k = 0; k < 2; k++) {
      r.u32(Math.round(doc.dpi! * 65536));
      r.u16(1);
      r.u16(1);
    }
  });
  const records = flatten(doc.layers);
  o.section((lm) => {
    lm.section((li) => {
      li.i16(records.length);
      const data: Uint8Array[][][] = [];
      for (const rec of records) {
        const l = "layer" in rec ? rec.layer : null;
        const divider = "divider" in rec && rec.divider;
        const group = "group" in rec ? rec.group : null;
        const w = l ? l.width : 0;
        const h = l ? l.height : 0;
        // Alpha, red, green, blue; a group record has no pixels, so each channel is just its compression flag.
        const channels = l ? [3, 0, 1, 2].map((offset) => rleChannel(l.rgba, w, h, 4, offset)) : [[], [], [], []];
        data.push(channels);
        li.i32(l ? l.top : 0);
        li.i32(l ? l.left : 0);
        li.i32(l ? l.top + h : 0);
        li.i32(l ? l.left + w : 0);
        li.u16(4);
        for (const [k, rows] of channels.entries()) {
          li.i16(k - 1);
          li.u32(l ? 2 + rows.length * 2 + rows.reduce((n, r) => n + r.byteLength, 0) : 2);
        }
        li.ascii("8BIM");
        li.ascii(l || divider ? "norm" : "pass");
        li.u8(Math.round((l?.opacity ?? 1) * 255));
        li.u8(0); // clipping
        const hidden = l ? l.hidden : group?.hidden;
        // Bit 1 hides the layer; bit 3 says bit 4 is meaningful, and bit 4 marks pixels irrelevant (groups).
        li.u8((hidden ? 2 : 0) | (l ? 0 : 8 | 16));
        li.u8(0);
        const name = l ? l.name : divider ? "</Layer group>" : (group?.name ?? "");
        li.section((x) => {
          x.u32(0); // no mask
          x.u32(0); // no blending ranges
          pascal(x, name, 4);
          extra(x, "luni", (u) => {
            u.u32(name.length);
            for (let i = 0; i < name.length; i++) u.u16(name.charCodeAt(i));
          });
          if (!l)
            extra(x, "lsct", (s) => {
              // 1: an open folder; 3: the divider closing it.
              s.u32(divider ? 3 : 1);
              if (!divider) {
                s.ascii("8BIM");
                s.ascii("pass");
              }
            });
        });
      }
      for (const channels of data)
        for (const rows of channels) {
          if (!rows.length) {
            li.u16(0);
            continue;
          }
          li.u16(1);
          for (const r of rows) li.u16(r.byteLength);
          for (const r of rows) li.bytes(r);
        }
    }, 2);
    lm.u32(0); // global layer mask info
  });
  // The flattened image: RLE, every row's byte count for all three channels first, then the rows.
  const merged = [0, 1, 2].map((c) => rleChannel(doc.composite, width, height, 3, c));
  o.u16(1);
  for (const rows of merged) for (const r of rows) o.u16(r.byteLength);
  for (const rows of merged) for (const r of rows) o.bytes(r);
  return o.concat();
}
