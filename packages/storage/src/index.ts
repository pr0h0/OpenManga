import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { S3AssetStorage } from "./s3.ts";

export type StoredObjectMetadata = { key: string; byteSize: number; modifiedAt: Date };

export interface AssetStorage {
  put(key: string, data: Uint8Array): Promise<StoredObjectMetadata>;
  /** Stores a file from disk without loading it into memory. */
  putFile(key: string, srcPath: string): Promise<StoredObjectMetadata>;
  read(key: string): Promise<Uint8Array>;
  /** The object as a stream, for files too large to hold in memory (videos). */
  stream(key: string): ReadableStream<Uint8Array>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  getMetadata(key: string): Promise<StoredObjectMetadata | null>;
  /** Local disk: the path nginx serves through X-Accel-Redirect, relative to the storage root. */
  internalPath?(key: string): string;
  /** Remote storage: a short-lived URL a browser can download the object from directly. */
  presign?(key: string, opts: PresignOptions): string;
}

export type PresignOptions = { expiresIn: number; contentType: string; contentDisposition?: string };

const KEY_RE = /^[a-z0-9][a-z0-9/_.-]*$/;

export class InvalidStorageKeyError extends Error {}

export function assertSafeKey(key: string) {
  if (!KEY_RE.test(key) || key.includes("..") || key.includes("//") || key.endsWith("/")) {
    throw new InvalidStorageKeyError(`Invalid storage key: ${JSON.stringify(key)}`);
  }
}

/** Opaque, non-guessable, sharded key. Never derived from user filenames. */
export function newStorageKey(prefix: string, ext: string) {
  const id = randomBytes(16).toString("hex");
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").toLowerCase() || "bin";
  const safePrefix = prefix.replace(/[^a-z0-9_-]/gi, "").toLowerCase() || "misc";
  return `${safePrefix}/${id.slice(0, 2)}/${id.slice(2, 4)}/${id}.${safeExt}`;
}

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export async function sha256File(path: string) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk);
  return h.digest("hex");
}

export class LocalAssetStorage implements AssetStorage {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private path(key: string) {
    assertSafeKey(key);
    const full = resolve(this.root, key);
    if (!full.startsWith(this.root + sep)) throw new InvalidStorageKeyError("Path escapes storage root");
    return full;
  }

  async put(key: string, data: Uint8Array) {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(4).toString("hex")}`;
    await writeFile(tmp, data);
    await rename(tmp, full);
    return { key, byteSize: data.byteLength, modifiedAt: new Date() };
  }

  async putFile(key: string, srcPath: string) {
    const full = this.path(key);
    await mkdir(dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${randomBytes(4).toString("hex")}`;
    await copyFile(srcPath, tmp);
    await rename(tmp, full);
    const s = await stat(full);
    return { key, byteSize: s.size, modifiedAt: s.mtime };
  }

  async read(key: string) {
    return new Uint8Array(await readFile(this.path(key)));
  }

  stream(key: string) {
    return Bun.file(this.path(key)).stream();
  }

  async exists(key: string) {
    return (await this.getMetadata(key)) !== null;
  }

  async delete(key: string) {
    await unlink(this.path(key)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  }

  async getMetadata(key: string) {
    try {
      const s = await stat(this.path(key));
      return { key, byteSize: s.size, modifiedAt: s.mtime };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  internalPath(key: string) {
    assertSafeKey(key);
    return key;
  }
}

export { presignV4, S3AssetStorage } from "./s3.ts";

/** The storage `STORAGE_DRIVER` names. */
export function createAssetStorage(c: {
  STORAGE_DRIVER: "local" | "s3";
  ASSET_ROOT: string;
  S3_ENDPOINT: string;
  S3_PUBLIC_ENDPOINT: string;
  S3_BUCKET: string;
  S3_REGION: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_PREFIX: string;
}): AssetStorage {
  if (c.STORAGE_DRIVER === "local") return new LocalAssetStorage(c.ASSET_ROOT);
  return new S3AssetStorage({
    bucket: c.S3_BUCKET,
    region: c.S3_REGION,
    accessKeyId: c.S3_ACCESS_KEY_ID,
    secretAccessKey: c.S3_SECRET_ACCESS_KEY,
    endpoint: c.S3_ENDPOINT,
    publicEndpoint: c.S3_PUBLIC_ENDPOINT,
    forcePathStyle: c.S3_FORCE_PATH_STYLE,
    prefix: c.S3_PREFIX,
  });
}

/** Dedicated temp workspace; callers must dispose. */
export async function withTempDir<T>(tempRoot: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = join(tempRoot, `mf-${Date.now()}-${randomBytes(6).toString("hex")}`);
  await mkdir(dir, { recursive: true });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
