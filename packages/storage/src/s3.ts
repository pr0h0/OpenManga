import { createHash, createHmac } from "node:crypto";
import { stat } from "node:fs/promises";
import { type AssetStorage, assertSafeKey, type PresignOptions, type StoredObjectMetadata } from "./index.ts";

export type S3StorageOptions = {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Empty for AWS. */
  endpoint?: string;
  /** The endpoint browsers reach, when it differs from the one the server uses (e.g. `http://minio:9000`). */
  publicEndpoint?: string;
  forcePathStyle: boolean;
  /** Prepended to every key, e.g. `openmanga/`. */
  prefix?: string;
};

/** Files above this go up in parts streamed from disk; smaller ones in one request. */
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const PART_SIZE = 16 * 1024 * 1024;

const isMissing = (e: unknown) => (e as { code?: string }).code === "NoSuchKey";

/**
 * Assets in an S3-compatible bucket through Bun's S3 client. The object key is `<prefix><storage key>`, so a local
 * install's files map one to one (`ASSET_ROOT/<key>` -> `<prefix><key>`).
 */
export class S3AssetStorage implements AssetStorage {
  private readonly client: Bun.S3Client;
  /** Signs URLs for browsers; signing is local, so it may name a host the server itself cannot reach. */
  private readonly publicClient: Bun.S3Client;
  private readonly prefix: string;

  constructor(private readonly o: S3StorageOptions) {
    const client = (endpoint?: string) =>
      new Bun.S3Client({
        bucket: o.bucket,
        region: o.region,
        accessKeyId: o.accessKeyId,
        secretAccessKey: o.secretAccessKey,
        ...(endpoint ? virtualHosted(endpoint, o) : {}),
      });
    this.client = client(o.endpoint);
    this.publicClient = client(o.publicEndpoint || o.endpoint);
    this.prefix = o.prefix ? `${o.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
    if (this.prefix) assertSafeKey(this.prefix.slice(0, -1));
  }

  private key(key: string) {
    assertSafeKey(key);
    return this.prefix + key;
  }

  async put(key: string, data: Uint8Array) {
    await this.client.write(this.key(key), data);
    return { key, byteSize: data.byteLength, modifiedAt: new Date() };
  }

  async putFile(key: string, srcPath: string) {
    const size = (await stat(srcPath)).size;
    if (size <= MULTIPART_THRESHOLD) await this.client.write(this.key(key), Bun.file(srcPath));
    else await this.multipartUpload(this.key(key), srcPath, size);
    return { key, byteSize: size, modifiedAt: new Date() };
  }

  async read(key: string) {
    return new Uint8Array(await this.client.file(this.key(key)).arrayBuffer());
  }

  stream(key: string) {
    return this.client.file(this.key(key)).stream();
  }

  async exists(key: string) {
    return this.client.exists(this.key(key));
  }

  async delete(key: string) {
    await this.client.delete(this.key(key));
  }

  async getMetadata(key: string): Promise<StoredObjectMetadata | null> {
    try {
      const s = await this.client.stat(this.key(key));
      return { key, byteSize: s.size, modifiedAt: s.lastModified };
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  /** Throws unless the bucket exists and the key may list it (HEAD on a missing bucket only reads as "no object"). */
  async check() {
    await this.client.list({ maxKeys: 1, ...(this.prefix ? { prefix: this.prefix } : {}) });
  }

  presign(key: string, opts: PresignOptions) {
    return this.publicClient.presign(this.key(key), {
      expiresIn: opts.expiresIn,
      type: opts.contentType,
      ...(opts.contentDisposition ? { contentDisposition: opts.contentDisposition } : {}),
    });
  }

  /**
   * Multipart upload read straight from disk, one part in memory at a time. Bun's own writer accepts a large file
   * too, but queues all of it in memory first (an 800 MB video peaked at 1.6 GB RSS), so the parts are sent with
   * SigV4-signed URLs instead. The bucket URL comes from Bun's own presign, so both agree on path or host style.
   */
  private async multipartUpload(objectKey: string, srcPath: string, size: number) {
    const call = async (method: string, query: Record<string, string>, body?: BodyInit) => {
      for (let attempt = 1; ; attempt++) {
        const res = await fetch(this.signedUrl(objectKey, method, query), { method, body });
        if (res.ok) return res;
        const text = await res.text();
        if (attempt >= 3 || res.status < 500)
          throw new Error(`S3 ${method} ${objectKey} failed: ${res.status} ${text.slice(0, 300)}`);
      }
    };
    const created = await (await call("POST", { uploads: "" })).text();
    const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(created)?.[1];
    if (!uploadId) throw new Error(`S3 did not start a multipart upload for ${objectKey}`);
    try {
      const parts: string[] = [];
      // ponytail: parts go up one at a time; a small pool would be faster on high-latency links.
      for (let n = 1, start = 0; start < size; n++, start += PART_SIZE) {
        const body = Bun.file(srcPath).slice(start, Math.min(size, start + PART_SIZE));
        const res = await call("PUT", { partNumber: String(n), uploadId }, body);
        parts.push(`<Part><PartNumber>${n}</PartNumber><ETag>${res.headers.get("etag")}</ETag></Part>`);
      }
      const done = await call(
        "POST",
        { uploadId },
        `<CompleteMultipartUpload>${parts.join("")}</CompleteMultipartUpload>`,
      );
      // S3 can answer 200 and still report an error in the body.
      const text = await done.text();
      if (text.includes("<Error>")) throw new Error(`S3 could not complete ${objectKey}: ${text.slice(0, 300)}`);
    } catch (e) {
      await fetch(this.signedUrl(objectKey, "DELETE", { uploadId }), { method: "DELETE" }).catch(() => {});
      throw e;
    }
  }

  /** A SigV4 query-signed URL (unsigned payload) for one multipart call. */
  signedUrl(objectKey: string, method: string, query: Record<string, string>, now = new Date()) {
    return presignV4(this.client.presign(objectKey), method, query, this.o, now);
  }
}

/**
 * Re-signs `base` (a URL Bun presigned for the object, used only for its origin and path) for `method` with extra
 * query parameters, which Bun's presign cannot add.
 */
export function presignV4(
  base: string,
  method: string,
  query: Record<string, string>,
  creds: { region: string; accessKeyId: string; secretAccessKey: string },
  now: Date,
  expiresIn = 3600,
) {
  const url = new URL(base);
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${creds.region}/s3/aws4_request`;
  const params: Record<string, string> = {
    ...query,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${creds.accessKeyId}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k]!)}`)
    .join("&");
  const canonical = [method, url.pathname, canonicalQuery, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonical).digest("hex")].join("\n");
  const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, day), creds.region), "s3"), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(toSign).digest("hex");
  return `${url.origin}${url.pathname}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);

/** Virtual-hosted addressing puts the bucket in the hostname, which Bun expects already in the endpoint. */
function virtualHosted(endpoint: string, o: Pick<S3StorageOptions, "bucket" | "forcePathStyle">) {
  if (o.forcePathStyle) return { endpoint };
  const u = new URL(endpoint);
  u.hostname = `${o.bucket}.${u.hostname}`;
  return { endpoint: u.origin, virtualHostedStyle: true };
}
