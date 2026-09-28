import { describe, expect, test } from "bun:test";
import type { AppConfig } from "@openmanga/config";
import type { Database } from "@openmanga/db";
import { refuseRedirect } from "@openmanga/domain";
import {
  assertPublicHttpsUrl,
  CredentialError,
  CredentialService,
  isPrivateAddress,
  KeyRing,
  keyId,
} from "./credentials.ts";

const cfg = {
  SESSION_SECRET: "x".repeat(40),
  CREDENTIALS_ENCRYPTION_KEY: "",
  CREDENTIALS_ENCRYPTION_OLD_KEYS: "",
  AI_MOCK_MODE: false,
} as AppConfig;

describe("credential encryption and key rotation", () => {
  const A = "ab".repeat(32);
  const B = "cd".repeat(32);
  test("round-trips with a key id, fresh IV, and rejects tampering", () => {
    const ring = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: A });
    const a = ring.encrypt("sk-live-secret-1234");
    expect(a.startsWith(`v2.${ring.primary.id}.`)).toBe(true);
    expect(ring.encrypt("sk-live-secret-1234")).not.toBe(a);
    expect(a).not.toContain("secret");
    expect(ring.decrypt(a)).toBe("sk-live-secret-1234");
    const parts = a.split(".");
    // Change a character in the middle: the last base64 characters can carry only padding bits, or already be "AA".
    const t = parts[4]!;
    const mid = Math.floor(t.length / 2);
    parts[4] = `${t.slice(0, mid)}${t[mid] === "A" ? "B" : "A"}${t.slice(mid + 1)}`;
    expect(() => ring.decrypt(parts.join("."))).toThrow();
    expect(() => new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: "short" })).toThrow();
  });

  test("with no explicit key the ring derives one from SESSION_SECRET and reads its own values back", () => {
    // What an install with CREDENTIALS_ENCRYPTION_KEY unset writes: a key derived from SESSION_SECRET.
    const derived = new KeyRing(cfg);
    const stored = derived.encrypt("sk-derived-secret");
    expect(derived.needsRotation(stored)).toBe(false);
    // A fresh process with the same SESSION_SECRET reads it; one with a different secret cannot.
    expect(new KeyRing(cfg).decrypt(stored)).toBe("sk-derived-secret");
    expect(() => new KeyRing({ ...cfg, SESSION_SECRET: "y".repeat(40) }).decrypt(stored)).toThrow("not configured");
    // Setting an explicit key makes it the primary; the derived key stays in the ring, so nothing becomes unreadable.
    const withKey = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: A });
    expect(withKey.primary.id).toBe(keyId(Buffer.from(A, "hex")));
    expect(withKey.decrypt(stored)).toBe("sk-derived-secret");
    expect(withKey.needsRotation(stored)).toBe(true);
    expect(withKey.decrypt(withKey.encrypt("next"))).toBe("next");
  });

  test("during rotation both keys decrypt; after dropping the old key only rotated values work", () => {
    const oldRing = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: A });
    const notYetRotated = oldRing.encrypt("key-one");
    const rotating = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: B, CREDENTIALS_ENCRYPTION_OLD_KEYS: A });
    expect(rotating.decrypt(notYetRotated)).toBe("key-one");
    expect(rotating.needsRotation(notYetRotated)).toBe(true);
    const rotated = rotating.encrypt(rotating.decrypt(notYetRotated));
    expect(rotating.needsRotation(rotated)).toBe(false);
    // a process still on the old config can't read the new value, but the rotating ring reads both
    expect(() => oldRing.decrypt(rotated)).toThrow("not configured");
    expect(rotating.decrypt(rotated)).toBe("key-one");
    const done = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: B });
    expect(done.decrypt(rotated)).toBe("key-one");
    expect(() => done.decrypt(notYetRotated)).toThrow("not configured");
  });

  test("legacy v1 values and the SESSION_SECRET-derived key keep working", () => {
    const derivedRing = new KeyRing(cfg);
    const fromDerived = derivedRing.encrypt("legacy-derived");
    // switching to a dedicated key still reads values written with the derived key
    const dedicated = new KeyRing({ ...cfg, CREDENTIALS_ENCRYPTION_KEY: A });
    expect(dedicated.decrypt(fromDerived)).toBe("legacy-derived");
    const [, , iv, tag, ct] = dedicated.encrypt("old-format").split(".");
    expect(dedicated.decrypt(["v1", iv, tag, ct].join("."))).toBe("old-format");
    expect(dedicated.needsRotation(["v1", iv, tag, ct].join("."))).toBe(true);
  });
});

describe("custom endpoint safety", () => {
  test("private and internal addresses are blocked", async () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "::ffff:10.0.0.1",
    ])
      expect(isPrivateAddress(ip)).toBe(true);
    for (const ip of ["8.8.8.8", "104.18.2.3", "2606:4700::1111"]) expect(isPrivateAddress(ip)).toBe(false);
    const resolve = async (h: string) => (h === "postgres" ? ["172.23.0.2"] : ["104.18.2.3"]);
    await expect(assertPublicHttpsUrl("http://api.example.com/v1", resolve)).rejects.toBeInstanceOf(CredentialError);
    await expect(assertPublicHttpsUrl("https://postgres:5432", resolve)).rejects.toThrow("public");
    await expect(assertPublicHttpsUrl("https://169.254.169.254/latest", resolve)).rejects.toThrow("public");
    expect(await assertPublicHttpsUrl("https://api.example.com/v1/", resolve)).toBe("https://api.example.com/v1");
  });

  test("allowPrivate is the only way to reach a private endpoint, and still rejects junk", async () => {
    const resolve = async () => ["10.0.0.4"];
    // The bundled mock provider service lives on the compose network; only a non-production instance may name it.
    await expect(assertPublicHttpsUrl("http://mock-ai:4010/v1", resolve)).rejects.toBeInstanceOf(CredentialError);
    expect(await assertPublicHttpsUrl("http://mock-ai:4010/v1", resolve, { allowPrivate: true })).toBe(
      "http://mock-ai:4010/v1",
    );
    await expect(assertPublicHttpsUrl("not a url", resolve, { allowPrivate: true })).rejects.toThrow("valid URL");
    await expect(assertPublicHttpsUrl("ftp://mock-ai/v1", resolve, { allowPrivate: true })).rejects.toThrow(
      "http or https",
    );
    await expect(assertPublicHttpsUrl("http://user:pw@mock-ai/v1", resolve, { allowPrivate: true })).rejects.toThrow(
      "credentials",
    );
  });
});

describe("outbound provider calls", () => {
  test("a redirect is refused instead of followed", () => {
    // A host that passed validation could answer 302 to an internal address; every adapter sets redirect: "manual".
    expect(() => refuseRedirect("openai", new Response(null, { status: 200 }))).not.toThrow();
    for (const status of [301, 302, 303, 307, 308])
      expect(() => refuseRedirect("openai", new Response(null, { status }))).toThrow("redirect");
  });
});

describe("model listing", () => {
  const svc = (body: unknown, status = 200) =>
    new CredentialService(
      {} as Database,
      cfg,
      (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch,
    );

  test("splits OpenAI-style lists by capability and merges catalog suggestions", async () => {
    const s = svc({ data: [{ id: "gpt-image-2" }, { id: "gpt-5" }, { id: "whisper-1" }] });
    const cred = { kind: "openai" as const, baseUrl: null, apiKey: "sk-test-12345678" };
    expect(await s.listModels(cred, "image")).toContain("gpt-image-2");
    const text = await s.listModels(cred, "text");
    expect(text).toContain("gpt-5");
    expect(text).not.toContain("gpt-image-2");
  });

  test("OpenRouter output modalities and Google model names are understood; bad keys are reported", async () => {
    const or = svc({ data: [{ id: "x/painter", architecture: { output_modalities: ["image"] } }, { id: "x/chat" }] });
    const orCred = { kind: "openrouter" as const, baseUrl: null, apiKey: "sk-or-12345678" };
    expect(await or.listModels(orCred, "image")).toContain("x/painter");
    expect(await or.listModels(orCred, "text")).not.toContain("x/painter");
    const g = svc({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    });
    const gText = await g.listModels({ kind: "google", baseUrl: null, apiKey: "AIza12345678" }, "text");
    expect(gText).toContain("gemini-2.5-flash");
    expect(gText).not.toContain("embedding-001");
    await expect(svc({ error: "no" }, 401).listModels(orCred, "text")).rejects.toThrow("rejected the API key");
  });
});
