import { type FileHandle, open } from "node:fs/promises";
import { crc32 } from "node:zlib";
import { UnrecoverableError } from "@openmanga/queue";
import type { FileSink } from "bun";
import { Unzip, UnzipInflate } from "fflate";

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;

type CentralEntry = { name: Uint8Array; crc: number; size: number; offset: number; time: number; date: number };

/**
 * Stored (uncompressed) ZIP written straight to disk; only the entry being added is in memory. Sizes, offsets and
 * the entry count past the classic format's limits (4 GiB, 65,535 entries) switch that record to ZIP64, so a
 * package of any size is written; smaller archives stay plain ZIP, readable by every tool.
 */
export class ZipWriter {
  private readonly file: Promise<FileHandle>;
  private readonly central: CentralEntry[] = [];
  private readonly names = new Set<string>();
  private offset = 0;

  constructor(
    readonly path: string,
    /** Sizes and offsets from this value up take ZIP64 fields. Tests lower it to write ZIP64 without 4 GiB of data. */
    private readonly zip64From = MAX32,
  ) {
    this.file = open(path, "w");
  }

  /** Later entries with an already-used name are skipped. */
  async add(name: string, data: Uint8Array) {
    if (this.names.has(name)) return;
    this.names.add(name);
    const header = this.localHeader(name, data.byteLength, crc32(data));
    await this.write(header);
    await this.write(data);
  }

  /**
   * A large entry, chunk by chunk from a stream, so a multi-GB video never sits in memory. `size` comes from the
   * asset row; the CRC is only known at the end, so it is written into the header afterwards.
   */
  async addStream(name: string, stream: ReadableStream<Uint8Array>, size: number) {
    if (this.names.has(name)) return;
    this.names.add(name);
    const header = this.localHeader(name, size, 0);
    const crcAt = this.offset + 14;
    await this.write(header);
    let crc = 0;
    let written = 0;
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      crc = crc32(r.value, crc);
      written += r.value.byteLength;
      await this.write(r.value);
    }
    if (written !== size) throw new Error(`ZIP entry ${name} was ${written} bytes, expected ${size}`);
    const patch = new Uint8Array(4);
    new DataView(patch.buffer).setUint32(0, crc, true);
    await (await this.file).write(patch, 0, 4, crcAt);
    this.central.at(-1)!.crc = crc;
  }

  async close() {
    const cdStart = this.offset;
    for (const e of this.central) await this.write(this.centralHeader(e));
    const cdSize = this.offset - cdStart;
    const count = this.central.length;
    const zip64 = count >= Math.min(MAX16, this.zip64From) || cdStart >= this.zip64From || cdSize >= this.zip64From;
    if (zip64) {
      // ZIP64 end of central directory record, then its locator; the classic record below points readers at them.
      const at = this.offset;
      const rec = new Uint8Array(56 + 20);
      const v = new DataView(rec.buffer);
      v.setUint32(0, 0x06064b50, true);
      v.setBigUint64(4, 44n, true);
      v.setUint16(12, 45, true);
      v.setUint16(14, 45, true);
      v.setBigUint64(24, BigInt(count), true);
      v.setBigUint64(32, BigInt(count), true);
      v.setBigUint64(40, BigInt(cdSize), true);
      v.setBigUint64(48, BigInt(cdStart), true);
      v.setUint32(56, 0x07064b50, true);
      v.setBigUint64(64, BigInt(at), true);
      v.setUint32(72, 1, true);
      await this.write(rec);
    }
    const end = new Uint8Array(22);
    const v = new DataView(end.buffer);
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, zip64 ? MAX16 : count, true);
    v.setUint16(10, zip64 ? MAX16 : count, true);
    v.setUint32(12, zip64 ? MAX32 : cdSize, true);
    v.setUint32(16, zip64 ? MAX32 : cdStart, true);
    await this.write(end);
    await (await this.file).close();
    return this.path;
  }

  private localHeader(name: string, size: number, crc: number) {
    const encoded = new TextEncoder().encode(name);
    const zip64 = size >= this.zip64From;
    const { time, date } = dosTime(new Date());
    this.central.push({ name: encoded, crc, size, offset: this.offset, time, date });
    const h = new Uint8Array(30 + encoded.byteLength + (zip64 ? 20 : 0));
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, zip64 ? 45 : 20, true);
    v.setUint16(6, 0x0800, true); // names are UTF-8
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, crc, true);
    v.setUint32(18, zip64 ? MAX32 : size, true);
    v.setUint32(22, zip64 ? MAX32 : size, true);
    v.setUint16(26, encoded.byteLength, true);
    v.setUint16(28, zip64 ? 20 : 0, true);
    h.set(encoded, 30);
    if (zip64) {
      const x = 30 + encoded.byteLength;
      v.setUint16(x, 1, true);
      v.setUint16(x + 2, 16, true);
      v.setBigUint64(x + 4, BigInt(size), true);
      v.setBigUint64(x + 12, BigInt(size), true);
    }
    return h;
  }

  private centralHeader(e: CentralEntry) {
    const bigSize = e.size >= this.zip64From;
    const bigOffset = e.offset >= this.zip64From;
    // The ZIP64 extra holds only the fields that overflowed, in this fixed order: sizes, then the offset.
    const extra = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
    const h = new Uint8Array(46 + e.name.byteLength + (extra ? 4 + extra : 0));
    const v = new DataView(h.buffer);
    const version = extra ? 45 : 20;
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, version, true);
    v.setUint16(6, version, true);
    v.setUint16(8, 0x0800, true);
    v.setUint16(12, e.time, true);
    v.setUint16(14, e.date, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, bigSize ? MAX32 : e.size, true);
    v.setUint32(24, bigSize ? MAX32 : e.size, true);
    v.setUint16(28, e.name.byteLength, true);
    v.setUint16(30, extra ? 4 + extra : 0, true);
    v.setUint32(42, bigOffset ? MAX32 : e.offset, true);
    h.set(e.name, 46);
    if (extra) {
      let x = 46 + e.name.byteLength;
      v.setUint16(x, 1, true);
      v.setUint16(x + 2, extra, true);
      x += 4;
      if (bigSize) {
        v.setBigUint64(x, BigInt(e.size), true);
        v.setBigUint64(x + 8, BigInt(e.size), true);
        x += 16;
      }
      if (bigOffset) v.setBigUint64(x, BigInt(e.offset), true);
    }
    return h;
  }

  private async write(data: Uint8Array) {
    const fh = await this.file;
    for (let done = 0; done < data.byteLength; ) {
      const { bytesWritten } = await fh.write(data, done, data.byteLength - done, this.offset);
      done += bytesWritten;
      this.offset += bytesWritten;
    }
  }
}

function dosTime(d: Date) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** Limits applied while extracting a package, all enforced as chunks arrive rather than after decompression. */
export type ExtractLimits = {
  /** Largest single entry. */
  maxEntryBytes: number;
  /** Largest total across every extracted entry. */
  maxTotalBytes: number;
  /**
   * Uncompressed-to-compressed ceiling. Real packages are PNG and WAV, which do not compress: both published
   * samples measure exactly 1.0, so anything past a small multiple of the archive's own size is a bomb rather
   * than a big project. This is what lets the size limits be a memory decision instead of a security one.
   */
  maxRatio: number;
  /** The ratio is only meaningful once there is some input to compare against (a tiny JSON-only package does compress). */
  ratioFloorBytes?: number;
};

/** Entries of a package, kept on disk: peak memory is one asset, not the archive. */
export type ExtractedFiles = {
  has(path: string): boolean;
  read(path: string): Promise<Uint8Array>;
  /** Extracted (uncompressed) bytes in total. */
  readonly bytes: number;
};

/**
 * Streams a ZIP from `path`, writing the entries `wanted` selects into `dir` and returning an accessor for them.
 * Nothing is buffered beyond the current chunk, so a 1.5 GB package costs the same memory as a small one.
 *
 * `wanted` maps an archive entry name to the key it should be stored under, or null to skip it (skipped entries
 * are never decompressed).
 */
export async function extractZip(opts: {
  path: string;
  dir: string;
  wanted: (name: string) => string | null;
  limits: ExtractLimits;
  /** Called with the completed keys after each chunk; return true to stop reading the rest of the archive. */
  stopWhen?: (done: ReadonlySet<string>) => boolean;
}): Promise<ExtractedFiles> {
  const { mkdir } = await import("node:fs/promises");
  const { join } = await import("node:path");
  await mkdir(opts.dir, { recursive: true });
  const file = Bun.file(opts.path);
  const compressed = file.size;
  const floor = opts.limits.ratioFloorBytes ?? 1024 * 1024;
  const paths = new Map<string, string>();
  /** Keys whose last chunk has arrived; with `stopWhen` this is how a pass ends before the whole archive is read. */
  const completed = new Set<string>();
  const sinks = new Map<string, FileSink>();
  let total = 0;
  let index = 0;
  let failure: Error | null = null;

  const fail = (message: string) => {
    failure ??= new UnrecoverableError(message);
  };

  // Collect every 64 MB of *input*: the chunks are dead as soon as they are written or skipped, but nothing else
  // in this loop allocates enough for the runtime to notice, so a large archive otherwise retains all of them.
  // Counting input rather than extracted bytes matters for a pass that skips most entries — finding project.json
  // in a 1.5 GB package extracts a few hundred KB while streaming all of it.
  const GC_EVERY = 64 * 1024 * 1024;
  let gcAt = 0;
  let read = 0;

  const unzip = new Unzip((entry) => {
    const key = opts.wanted(entry.name);
    if (key === null || paths.has(key)) {
      // Consume and drop it. An entry that is never started is buffered inside the unzipper rather than skipped,
      // so a pass that wants one entry out of a 1.5 GB archive would otherwise hold the whole archive in memory.
      entry.ondata = () => {};
      entry.start();
      return;
    }
    if (entry.originalSize !== undefined && entry.originalSize > opts.limits.maxEntryBytes)
      return fail(`ZIP entry ${entry.name} is larger than the ${mb(opts.limits.maxEntryBytes)} MB entry limit`);
    const out = join(opts.dir, `e${index++}`);
    paths.set(key, out);
    const sink = Bun.file(out).writer();
    sinks.set(key, sink);
    let written = 0;
    entry.ondata = (err, chunk, final) => {
      if (err) return fail(`ZIP entry ${entry.name} could not be read: ${err.message}`);
      if (failure) return;
      written += chunk.byteLength;
      total += chunk.byteLength;
      if (written > opts.limits.maxEntryBytes)
        return fail(`ZIP entry ${entry.name} is larger than the ${mb(opts.limits.maxEntryBytes)} MB entry limit`);
      if (total > opts.limits.maxTotalBytes)
        return fail(`Package contents exceed the ${mb(opts.limits.maxTotalBytes)} MB uncompressed limit`);
      if (compressed >= floor && total > compressed * opts.limits.maxRatio)
        return fail(
          `Package expands more than ${opts.limits.maxRatio}x (${mb(total)} MB from ${mb(compressed)} MB) and was refused`,
        );
      sink.write(chunk);
      if (final) {
        sinks.delete(key);
        completed.add(key);
        void sink.end();
      }
    };
    entry.start();
  });
  unzip.register(UnzipInflate);

  try {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (failure) break;
      if (done) {
        unzip.push(new Uint8Array(0), true);
        break;
      }
      read += value.byteLength;
      unzip.push(value, false);
      // Bounded buffering: flush what the open entries have taken from this chunk before reading the next.
      await Promise.all([...sinks.values()].map((s) => s.flush()));
      if (read - gcAt >= GC_EVERY) {
        gcAt = read;
        Bun.gc(false);
      }
      if (opts.stopWhen?.(completed)) {
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } catch (e) {
    if (!failure) failure = e instanceof Error ? e : new Error(String(e));
  }
  await Promise.all([...sinks.values()].map(async (s) => Promise.resolve(s.end()).catch(() => 0)));
  sinks.clear();
  if (failure) throw failure;

  return {
    has: (path: string) => paths.has(path),
    read: async (path: string) => {
      const p = paths.get(path);
      return p ? new Uint8Array(await Bun.file(p).arrayBuffer()) : new Uint8Array(0);
    },
    get bytes() {
      return total;
    },
  };
}

const mb = (n: number) => Math.round(n / (1024 * 1024));
