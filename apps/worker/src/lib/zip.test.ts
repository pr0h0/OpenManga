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
    await zip.addStream("video/big.mp4", Bun.file(src).stream());
    await zip.add("note.txt", new TextEncoder().encode("hi"));
    const files = unzipSync(new Uint8Array(await Bun.file(await zip.close()).arrayBuffer()));
    expect(files["video/big.mp4"]).toEqual(big);
    expect(new TextDecoder().decode(files["note.txt"])).toBe("hi");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
