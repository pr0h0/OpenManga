import { describe, expect, test } from "bun:test";
import { ConfigError, PublicUrlService, parseConfig } from "./index.ts";

const base = { DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", SESSION_SECRET: "x".repeat(40) };

describe("config", () => {
  test("only three variables are required; no provider keys exist", () => {
    const c = parseConfig(base);
    expect([c.REFERENCE_MAX_WIDTH, c.REFERENCE_MAX_HEIGHT]).toEqual([192, 288]);
    expect(c.imageSizes).toHaveLength(7);
    expect(c.imageSizes).not.toContainEqual({ width: 1024, height: 1024 });
    expect(c.IMAGE_QUALITY).toBe("low");
    expect(c.REFERENCE_ALLOW_UPSCALE).toBe(false);
    // Keys are the user's own (BYOK): the server has no provider key or provider selection at all.
    for (const k of [
      "OPENAI_API_KEY",
      "DEEPSEEK_API_KEY",
      "GOOGLE_API_KEY",
      "META_MUSE_API_KEY",
      "TEXT_PROVIDER",
      "IMAGE_PROVIDER",
    ])
      expect(k in c).toBe(false);
  });
  test("mock mode refused in production", () => {
    expect(() => parseConfig({ ...base, NODE_ENV: "production", AI_MOCK_MODE: "true" })).toThrow(ConfigError);
  });
  test("the Google OAuth client for YouTube stats is both id and secret, or neither", () => {
    expect(parseConfig(base).GOOGLE_OAUTH_CLIENT_ID).toBe("");
    expect(() => parseConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: "id" })).toThrow(ConfigError);
    expect(
      parseConfig({ ...base, GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "s" })
        .GOOGLE_OAUTH_CLIENT_SECRET,
    ).toBe("s");
  });
  test("production boots with no keys at all", () => {
    expect(parseConfig({ ...base, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
  });
  test("local storage by default; s3 refuses to start without its bucket and keys", () => {
    expect(parseConfig(base).STORAGE_DRIVER).toBe("local");
    expect(() => parseConfig({ ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "b" })).toThrow(/S3_ACCESS_KEY_ID/);
    const s3 = { ...base, STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" };
    expect(parseConfig(s3).S3_PRESIGN_EXPIRES_SECONDS).toBe(900);
    expect(() => parseConfig({ ...s3, S3_ENDPOINT: "minio:9000" })).toThrow(/S3_ENDPOINT/);
  });

  test("missing database fails", () => {
    expect(() => parseConfig({ REDIS_URL: "x", SESSION_SECRET: "x".repeat(40) })).toThrow(ConfigError);
  });
});

describe("PublicUrlService", () => {
  test("same domain paths", () => {
    const u = new PublicUrlService({
      appUrl: "https://manga.example.com/app",
      apiUrl: "https://manga.example.com/api/",
      cdnUrl: "https://manga.example.com/cdn",
    });
    expect(u.appUrl("projects/1")).toBe("https://manga.example.com/app/projects/1");
    expect(u.apiUrl("/auth/me")).toBe("https://manga.example.com/api/auth/me");
    expect(u.assetUrl("abc", "thumb")).toBe("https://manga.example.com/cdn/a/abc?v=thumb");
    expect(u.passwordResetUrl("t o")).toBe("https://manga.example.com/app/reset-password?token=t+o");
    expect(u.inviteUrl("abc")).toBe("https://manga.example.com/app/invite?token=abc");
  });
  test("subdomains", () => {
    const u = new PublicUrlService({
      appUrl: "https://app.x.tld",
      apiUrl: "https://api.x.tld",
      cdnUrl: "https://cdn.x.tld",
    });
    expect(u.apiUrl("healthz")).toBe("https://api.x.tld/healthz");
    expect(u.assetUrl("a/../b")).toBe("https://cdn.x.tld/a/a%2F..%2Fb");
  });
});
