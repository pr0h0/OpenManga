import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newStorageKey, presignV4, S3AssetStorage, sha256Hex } from "./index.ts";

const creds = {
  region: "eu-central-1",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

describe("presignV4", () => {
  test("signs exactly as Bun's own presign does", () => {
    const client = new Bun.S3Client({ ...creds, bucket: "media", endpoint: "http://minio:9000" });
    const bun = new URL(client.presign("panel_art/aa/bb/x.png", { expiresIn: 600 }));
    const date = bun.searchParams.get("X-Amz-Date")!;
    const now = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    const ours = new URL(presignV4(bun.href, "GET", {}, creds, now, 600));
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(bun.searchParams.get("X-Amz-Signature"));
    // Extra parameters are signed too.
    const part = new URL(presignV4(bun.href, "PUT", { partNumber: "2", uploadId: "a b" }, creds, now, 600));
    expect(part.searchParams.get("uploadId")).toBe("a b");
    expect(part.searchParams.get("X-Amz-Signature")).not.toBe(bun.searchParams.get("X-Amz-Signature"));
  });

  test("temporary credentials: the session token is signed as Bun signs it", () => {
    const temp = { ...creds, sessionToken: "FwoGZXIvYXdzEJr//token+with/odd=chars" };
    const client = new Bun.S3Client({ ...temp, bucket: "media", endpoint: "http://minio:9000" });
    const bun = new URL(client.presign("a/b.png", { expiresIn: 600 }));
    expect(bun.searchParams.get("X-Amz-Security-Token")).toBe(temp.sessionToken);
    const date = bun.searchParams.get("X-Amz-Date")!;
    const now = new Date(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    const ours = new URL(presignV4(bun.href, "GET", {}, temp, now, 600));
    expect(ours.searchParams.get("X-Amz-Security-Token")).toBe(temp.sessionToken);
    expect(ours.searchParams.get("X-Amz-Signature")).toBe(bun.searchParams.get("X-Amz-Signature"));
  });

  test("virtual-hosted addressing puts the bucket in the host; path style keeps it in the path", () => {
    const o = { ...creds, bucket: "media", endpoint: "https://s3.example.com" };
    const vhost = new URL(new S3AssetStorage({ ...o, forcePathStyle: false }).presign("a/b.png", presignOpts));
    expect(vhost.host).toBe("media.s3.example.com");
    expect(vhost.pathname).toBe("/a/b.png");
    const path = new URL(
      new S3AssetStorage({ ...o, forcePathStyle: true, prefix: "om/" }).presign("a/b.png", presignOpts),
    );
    expect(path.host).toBe("s3.example.com");
    expect(path.pathname).toBe("/media/om/a/b.png");
    // Browsers get the public endpoint; the type and file name ride along in the signed URL.
    const pub = new URL(
      new S3AssetStorage({ ...o, forcePathStyle: true, publicEndpoint: "https://files.example.com" }).presign(
        "a/b.png",
        {
          ...presignOpts,
          contentDisposition: 'attachment; filename="b.png"',
        },
      ),
    );
    expect(pub.host).toBe("files.example.com");
    expect(pub.searchParams.get("response-content-type")).toBe("image/png");
    expect(pub.searchParams.get("response-content-disposition")).toBe('attachment; filename="b.png"');
  });
});

const presignOpts = { expiresIn: 300, contentType: "image/png" };

/** A real round trip, against the S3-compatible server TEST_S3_ENDPOINT names (e.g. MinIO); skipped without one. */
describe.skipIf(!process.env.TEST_S3_ENDPOINT)("S3AssetStorage against a server", () => {
  const s = new S3AssetStorage({
    endpoint: process.env.TEST_S3_ENDPOINT,
    bucket: process.env.TEST_S3_BUCKET ?? "openmanga-test",
    region: "us-east-1",
    accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "minioadmin",
    secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin",
    forcePathStyle: true,
    prefix: `unit-${Date.now()}`,
  });

  test("check passes for the bucket and fails for a missing one", async () => {
    await s.check();
    const missing = new S3AssetStorage({
      endpoint: process.env.TEST_S3_ENDPOINT,
      bucket: "no-such-bucket-openmanga",
      region: "us-east-1",
      accessKeyId: process.env.TEST_S3_ACCESS_KEY_ID ?? "minioadmin",
      secretAccessKey: process.env.TEST_S3_SECRET_ACCESS_KEY ?? "minioadmin",
      forcePathStyle: true,
    });
    await expect(missing.check()).rejects.toThrow();
  });

  test("put, read, stream, metadata, presigned download, delete", async () => {
    const key = newStorageKey("panel_art", "png");
    await s.put(key, new TextEncoder().encode("hello"));
    expect(new TextDecoder().decode(await s.read(key))).toBe("hello");
    expect(await new Response(s.stream(key)).text()).toBe("hello");
    expect((await s.getMetadata(key))?.byteSize).toBe(5);
    const res = await fetch(s.presign(key, { ...presignOpts, contentDisposition: 'attachment; filename="h.png"' }));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toContain("h.png");
    expect(await res.text()).toBe("hello");
    await s.delete(key);
    expect(await s.exists(key)).toBe(false);
    expect(await s.getMetadata(key)).toBeNull();
    await s.delete(key); // idempotent
  });

  test("a large file goes up in parts and arrives intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "om-s3-"));
    try {
      const src = join(dir, "big.mp4");
      const data = new Uint8Array(70 * 1024 * 1024).map((_, i) => (i * 7) % 251);
      await Bun.write(src, data);
      const key = newStorageKey("export", "mp4");
      expect((await s.putFile(key, src)).byteSize).toBe(data.byteLength);
      expect(sha256Hex(await s.read(key))).toBe(sha256Hex(data));
      await s.delete(key);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
