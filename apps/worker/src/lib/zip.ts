import { UnrecoverableError } from "@openmanga/queue";
import type { FileSink } from "bun";
import { Unzip, UnzipInflate, Zip, ZipPassThrough } from "fflate";

// ponytail: fflate writes no ZIP64, so an archive must stay under 4 GiB and 65,535 entries (same limit zipSync had).
const MAX_ZIP_BYTES = 2 ** 32 - 1;

/** Stored (uncompressed) ZIP written straight to disk; only the entry being added is in memory. */
export class ZipWriter {
  private readonly sink;
  private readonly zip: Zip;
  private readonly names = new Set<string>();
  private error: Error | null = null;
  private bytes = 0;

  constructor(readonly path: string) {
    this.sink = Bun.file(path).writer();
    this.zip = new Zip((err, chunk) => {
      if (err) this.error = err;
      else {
        this.bytes += chunk.byteLength;
        this.sink.write(chunk);
      }
    });
  }

  /** Later entries with an already-used name are skipped. */
  async add(name: string, data: Uint8Array) {
    if (this.names.has(name)) return;
    this.names.add(name);
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    entry.push(data, true);
    await this.check();
  }

  /** A large entry, chunk by chunk from a stream, so a multi-GB video never sits in memory. */
  async addStream(name: string, stream: ReadableStream<Uint8Array>) {
    if (this.names.has(name)) return;
    this.names.add(name);
    const entry = new ZipPassThrough(name);
    this.zip.add(entry);
    const reader = stream.getReader();
    for (let r = await reader.read(); !r.done; r = await reader.read()) {
      entry.push(r.value);
      await this.check();
    }
    entry.push(new Uint8Array(), true);
    await this.check();
  }

  get entries() {
    return this.names.size;
  }

  async close() {
    this.zip.end();
    await this.check();
    await this.sink.end();
    return this.path;
  }

  private async check() {
    await this.sink.flush();
    if (this.error) throw this.error;
    if (this.bytes > MAX_ZIP_BYTES || this.names.size > 65_535)
      throw new UnrecoverableError("Archive is larger than 4 GB; export chapters separately");
  }
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
