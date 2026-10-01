import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { extractZip, ZipWriter } from "./zip.ts";

test("ZipWriter streams entries to a valid archive and skips duplicate names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-zip-"));
  try {
    const big = new Uint8Array(2 * 1024 * 1024).map((_, i) => i % 253);
    const zip = new ZipWriter(join(dir, "out.zip"));
    await zip.add("a/big.bin", big);
    await zip.add("b.txt", new TextEncoder().encode("hello"));
    await zip.add("b.txt", new TextEncoder().encode("ignored"));
    await zip.add("empty", new Uint8Array());
    const files = unzipSync(new Uint8Array(await Bun.file(await zip.close()).arrayBuffer()));
    expect(Object.keys(files).sort()).toEqual(["a/big.bin", "b.txt", "empty"]);
    expect(files["a/big.bin"]).toEqual(big);
    expect(new TextDecoder().decode(files["b.txt"])).toBe("hello");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A bomb: tiny compressed input declaring, and expanding to, far more than it could legitimately hold. */
const bombZip = (entries: number, perEntry: number) => {
  const files: Record<string, Uint8Array> = {};
  for (let i = 0; i < entries; i++) files[`assets/${i}.bin`] = new Uint8Array(perEntry); // zeros deflate ~1000:1
  return zipSync(files, { level: 6 });
};

test("extractZip streams entries to disk and reports their total", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-unzip-"));
  try {
    const payload = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 251);
    const archive = zipSync({ "project.json": new TextEncoder().encode("{}"), "assets/a.bin": payload }, { level: 0 });
    const path = join(dir, "in.zip");
    await Bun.write(path, archive);
    const out = await extractZip({
      path,
      dir: join(dir, "x"),
      // Skipped entries are never decompressed, so project.json is absent from the result.
      wanted: (name) => (name.startsWith("assets/") ? name : null),
      limits: { maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 16 * 1024 * 1024, maxRatio: 5 },
    });
    expect(out.has("assets/a.bin")).toBe(true);
    expect(out.has("project.json")).toBe(false);
    expect(await out.read("assets/a.bin")).toEqual(payload);
    expect(out.bytes).toBe(payload.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractZip refuses a zip bomb on the compression ratio, before the total limit is reached", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-unzip-bomb-"));
  try {
    const archive = bombZip(8, 2 * 1024 * 1024); // 16 MB of zeros from a few dozen KB
    const path = join(dir, "bomb.zip");
    await Bun.write(path, archive);
    expect(archive.byteLength).toBeLessThan(1024 * 1024);
    await expect(
      extractZip({
        path,
        dir: join(dir, "x"),
        wanted: (name) => name,
        // Deliberately generous absolute limits: the ratio is what has to catch this.
        limits: {
          maxEntryBytes: 512 * 1024 * 1024,
          maxTotalBytes: 4096 * 1024 * 1024,
          maxRatio: 5,
          ratioFloorBytes: 0,
        },
      }),
    ).rejects.toThrow(/expands more than 5x/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractZip aborts an oversized entry mid-stream and keeps a legitimate ratio flowing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-unzip-entry-"));
  try {
    // Incompressible content, so the ratio guard stays out of the way and the per-entry cap is what trips.
    const payload = crypto.getRandomValues(new Uint8Array(4 * 1024 * 1024));
    const archive = zipSync({ "assets/big.bin": payload }, { level: 0 });
    const path = join(dir, "big.zip");
    await Bun.write(path, archive);
    await expect(
      extractZip({
        path,
        dir: join(dir, "x"),
        wanted: (name) => name,
        limits: { maxEntryBytes: 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 5 },
      }),
    ).rejects.toThrow(/entry limit/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractZip does not apply the ratio guard when it is disabled (text manifests compress)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-unzip-json-"));
  try {
    // A hand-zipped project_json export: one big JSON entry, which deflates about 20x.
    const json = new TextEncoder().encode(JSON.stringify({ pages: Array.from({ length: 40_000 }, (_, i) => ({ i })) }));
    const archive = zipSync({ "project.json": json }, { level: 9 });
    expect(json.byteLength / archive.byteLength).toBeGreaterThan(5);
    const path = join(dir, "json.zip");
    await Bun.write(path, archive);
    const out = await extractZip({
      path,
      dir: join(dir, "x"),
      wanted: (name) => name,
      limits: {
        maxEntryBytes: 16 * 1024 * 1024,
        maxTotalBytes: 64 * 1024 * 1024,
        maxRatio: Number.POSITIVE_INFINITY,
      },
    });
    expect((await out.read("project.json")).byteLength).toBe(json.byteLength);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a streamed entry lands whole, chunk by chunk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mf-zip-"));
  try {
    const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
    const src = join(dir, "src.bin");
    await Bun.write(src, big);
    const zip = new ZipWriter(join(dir, "out.zip"));
    await zip.addStream("video/big.mp4", Bun.file(src).stream(), big.byteLength);
    await zip.add("note.txt", new TextEncoder().encode("hi"));
    const files = unzipSync(new Uint8Array(await Bun.file(await zip.close()).arrayBuffer()));
    expect(files["video/big.mp4"]).toEqual(big);
    expect(new TextDecoder().decode(files["note.txt"])).toBe("hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** Readers outside this codebase, when the machine has them (CI's Ubuntu runner does). */
const externalCheck = (path: string) => {
  if (Bun.which("unzip")) expect(Bun.spawnSync(["unzip", "-tqq", path]).exitCode).toBe(0);
  if (Bun.which("python3")) {
    const py = Bun.spawnSync([
      "python3",
      "-c",
      "import sys,zipfile; sys.exit(zipfile.ZipFile(sys.argv[1]).testzip() is not None)",
      path,
    ]);
    expect(py.exitCode).toBe(0);
  }
};

const u32 = (b: Uint8Array, at: number) => new DataView(b.buffer, b.byteOffset).getUint32(at, true);

test("ZIP64 records are written and read back when the classic limits are passed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-zip64-"));
  try {
    // Threshold 0: every size, offset and the entry count count as too big, so every ZIP64 field is exercised.
    const zip = new ZipWriter(join(dir, "out.zip"), 0);
    const big = new Uint8Array(1024 * 1024).map((_, i) => i % 249);
    await zip.add("mimetype", new TextEncoder().encode("application/epub+zip"));
    await zip.add("a/big.bin", big);
    const src = join(dir, "src.bin");
    await Bun.write(src, big);
    await zip.addStream("video/clip.mp4", Bun.file(src).stream(), big.byteLength);
    const path = await zip.close();
    const buf = new Uint8Array(await Bun.file(path).arrayBuffer());

    // Classic end record defers to the ZIP64 one: counts 0xFFFF, size and offset 0xFFFFFFFF.
    const eocd = buf.byteLength - 22;
    expect(u32(buf, eocd)).toBe(0x06054b50);
    expect(u32(buf, eocd + 12)).toBe(0xffffffff);
    expect(u32(buf, eocd + 16)).toBe(0xffffffff);
    expect(u32(buf, eocd - 20)).toBe(0x07064b50); // locator
    expect(u32(buf, eocd - 20 - 56)).toBe(0x06064b50); // ZIP64 end record

    const files = unzipSync(buf);
    expect(Object.keys(files).sort()).toEqual(["a/big.bin", "mimetype", "video/clip.mp4"]);
    expect(files["a/big.bin"]).toEqual(big);
    expect(files["video/clip.mp4"]).toEqual(big);
    // The streaming reader that imports use reads the ZIP64 local headers too.
    const out = await extractZip({
      path,
      dir: join(dir, "x"),
      wanted: (name) => name,
      limits: { maxEntryBytes: 8 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024, maxRatio: 5 },
    });
    expect(await out.read("video/clip.mp4")).toEqual(big);
    externalCheck(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an entry past the 4 GiB mark is found through its ZIP64 offset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "om-zip64-off-"));
  try {
    const zip = new ZipWriter(join(dir, "out.zip"));
    await zip.add("first.txt", new TextEncoder().encode("first"));
    // Stand-in for 5 GiB of earlier entries: writes are positional, so skipping ahead leaves a sparse hole on disk
    // instead of writing the bytes. Readers go by the central directory, which is what is being checked.
    (zip as unknown as { offset: number }).offset = 5 * 2 ** 30;
    const payload = new TextEncoder().encode("past four gibibytes");
    await zip.add("late.txt", payload);
    const path = await zip.close();
    const file = Bun.file(path);
    expect(file.size).toBeGreaterThan(5 * 2 ** 30);

    // Walk it the way a reader does, from the tail: end record → locator → ZIP64 end record → central directory.
    const tail = new Uint8Array(await file.slice(file.size - 22 - 20 - 56).arrayBuffer());
    const v = new DataView(tail.buffer);
    expect(v.getUint32(56 + 20, true)).toBe(0x06054b50);
    expect(v.getUint32(76 + 16, true)).toBe(0xffffffff); // central directory offset deferred to ZIP64
    expect(v.getUint32(56, true)).toBe(0x07064b50);
    expect(v.getUint32(0, true)).toBe(0x06064b50);
    const cdOffset = Number(v.getBigUint64(48, true));
    const cdSize = Number(v.getBigUint64(40, true));
    expect(Number(v.getBigUint64(32, true))).toBe(2);
    const cd = new Uint8Array(await file.slice(cdOffset, cdOffset + cdSize).arrayBuffer());
    const cv = new DataView(cd.buffer);
    const firstLen = 46 + cv.getUint16(28, true) + cv.getUint16(30, true);
    expect(cv.getUint32(42, true)).toBe(0); // first.txt: a plain offset
    // late.txt: offset 0xFFFFFFFF, real value in its ZIP64 extra (id 1, 8 bytes: the offset alone).
    expect(cv.getUint32(firstLen + 42, true)).toBe(0xffffffff);
    const extraAt = firstLen + 46 + cv.getUint16(firstLen + 28, true);
    expect(cv.getUint16(extraAt, true)).toBe(1);
    expect(cv.getUint16(extraAt + 2, true)).toBe(8);
    const local = Number(cv.getBigUint64(extraAt + 4, true));
    expect(local).toBe(5 * 2 ** 30);
    const head = new Uint8Array(await file.slice(local, local + 30 + 8 + payload.byteLength).arrayBuffer());
    expect(u32(head, 0)).toBe(0x04034b50);
    expect(new TextDecoder().decode(head.slice(30, 38))).toBe("late.txt");
    expect(head.slice(38)).toEqual(payload);
    if (Bun.which("python3")) {
      const py = Bun.spawnSync([
        "python3",
        "-c",
        "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); sys.exit(z.read('late.txt') != b'past four gibibytes')",
        path,
      ]);
      expect(py.exitCode).toBe(0);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
