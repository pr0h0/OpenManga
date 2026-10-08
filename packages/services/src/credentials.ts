import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { AppConfig } from "@openmanga/config";
import { and, type Database, type DbOrTx, desc, eq, providerCredentials, sql, youtubeChannels } from "@openmanga/db";
import { type AiCapability, ProviderError, type ProviderKind, providerCatalog } from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";

type KeyConfig = Pick<AppConfig, "CREDENTIALS_ENCRYPTION_KEY" | "CREDENTIALS_ENCRYPTION_OLD_KEYS" | "SESSION_SECRET">;

const parseKey = (raw: string, name: string) => {
  const buf = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error(`${name} must be 32 bytes (64 hex chars or base64)`);
  return buf;
};
/** HKDF salt for the fallback key derived from SESSION_SECRET. Changing it makes such credentials unreadable. */
const CREDENTIAL_SALT = "openmanga";
const sessionDerivedKey = (secret: string) =>
  Buffer.from(hkdfSync("sha256", secret, CREDENTIAL_SALT, "provider-credentials", 32));
/** Public, non-secret identifier of a key (first 12 hex of its SHA-256), stored next to each ciphertext. */
export const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 12);

/**
 * Encryption keys: the primary key encrypts; every configured key (primary, CREDENTIALS_ENCRYPTION_OLD_KEYS and the
 * SESSION_SECRET-derived fallback) can decrypt. Rotation = set a new primary, move the previous one to OLD_KEYS,
 * let `rotateCredentials` re-encrypt, then drop the old key.
 */
export class KeyRing {
  readonly primary: { id: string; key: Buffer };
  private readonly keys = new Map<string, Buffer>();

  constructor(config: KeyConfig) {
    const primary = config.CREDENTIALS_ENCRYPTION_KEY
      ? parseKey(config.CREDENTIALS_ENCRYPTION_KEY, "CREDENTIALS_ENCRYPTION_KEY")
      : sessionDerivedKey(config.SESSION_SECRET);
    this.primary = { id: keyId(primary), key: primary };
    const all = [
      primary,
      ...(config.CREDENTIALS_ENCRYPTION_OLD_KEYS ?? "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
        .map((k, i) => parseKey(k, `CREDENTIALS_ENCRYPTION_OLD_KEYS[${i}]`)),
      sessionDerivedKey(config.SESSION_SECRET),
    ];
    for (const k of all) if (!this.keys.has(keyId(k))) this.keys.set(keyId(k), k);
  }

  get ids() {
    return [...this.keys.keys()];
  }

  /** v2.<keyId>.<iv>.<tag>.<ciphertext> (base64url), AES-256-GCM with the primary key. */
  encrypt(plaintext: string) {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.primary.key, iv);
    const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
    return [
      "v2",
      this.primary.id,
      iv.toString("base64url"),
      c.getAuthTag().toString("base64url"),
      ct.toString("base64url"),
    ].join(".");
  }

  decrypt(token: string) {
    const parts = token.split(".");
    if (parts[0] === "v2" && parts.length === 5) {
      const key = this.keys.get(parts[1]!);
      if (!key) throw new CredentialError(`Credential was encrypted with key ${parts[1]}, which is not configured`);
      return open(key, parts[2]!, parts[3]!, parts[4]!);
    }
    if (parts[0] === "v1" && parts.length === 4) {
      // Legacy values carry no key id: try every configured key.
      for (const key of this.keys.values()) {
        try {
          return open(key, parts[1]!, parts[2]!, parts[3]!);
        } catch {}
      }
      throw new CredentialError("Legacy credential could not be decrypted with any configured key");
    }
    throw new CredentialError("Unsupported credential format");
  }

  /** True when a value is not yet encrypted with the primary key. */
  needsRotation(token: string) {
    return !token.startsWith(`v2.${this.primary.id}.`);
  }
}

function open(key: Buffer, iv: string, tag: string, ct: string) {
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

/**
 * Re-encrypts credentials that aren't on the primary key, in batches. Each row is swapped only if it still holds the
 * value that was read (compare-and-set), so concurrent key saves or deletes are never overwritten. Safe to run from
 * several processes at once; reads keep working throughout because every configured key can decrypt.
 */
export async function rotateCredentials(
  db: Database,
  ring: KeyRing,
  opts: { batchSize?: number; logger?: Logger } = {},
) {
  const batchSize = opts.batchSize ?? 200;
  let rotated = 0;
  let failed = 0;
  const skip = new Set<string>();
  for (;;) {
    const rows = await db
      .select({ id: providerCredentials.id, encryptedKey: providerCredentials.encryptedKey })
      .from(providerCredentials)
      .where(sql`${providerCredentials.encryptedKey} not like ${`v2.${ring.primary.id}.%`}`)
      .limit(batchSize + skip.size);
    const todo = rows.filter((r) => !skip.has(r.id));
    if (!todo.length) break;
    for (const r of todo) {
      try {
        const next = ring.encrypt(ring.decrypt(r.encryptedKey));
        const done = await db
          .update(providerCredentials)
          .set({ encryptedKey: next })
          .where(and(eq(providerCredentials.id, r.id), eq(providerCredentials.encryptedKey, r.encryptedKey)))
          .returning({ id: providerCredentials.id });
        if (done.length) rotated++;
      } catch (e) {
        failed++;
        skip.add(r.id);
        opts.logger?.error("credential rotation failed", { credentialId: r.id, error: (e as Error).message });
      }
    }
  }
  // YouTube channel tokens are encrypted with the same ring. A stale access token is simply dropped (it is refreshed
  // on next use); the refresh token is re-encrypted with the same compare-and-set.
  await db.execute(
    sql`update youtube_channels set encrypted_access_token = null where encrypted_access_token not like ${`v2.${ring.primary.id}.%`}`,
  );
  const yt = await db
    .select({ id: youtubeChannels.id, token: youtubeChannels.encryptedRefreshToken })
    .from(youtubeChannels)
    .where(
      sql`${youtubeChannels.encryptedRefreshToken} <> '' and ${youtubeChannels.encryptedRefreshToken} not like ${`v2.${ring.primary.id}.%`}`,
    );
  for (const r of yt) {
    try {
      const done = await db
        .update(youtubeChannels)
        .set({ encryptedRefreshToken: ring.encrypt(ring.decrypt(r.token)) })
        .where(and(eq(youtubeChannels.id, r.id), eq(youtubeChannels.encryptedRefreshToken, r.token)))
        .returning({ id: youtubeChannels.id });
      if (done.length) rotated++;
    } catch (e) {
      failed++;
      opts.logger?.error("youtube token rotation failed", { connectionId: r.id, error: (e as Error).message });
    }
  }
  const remaining = failed;
  if (rotated || failed) opts.logger?.info("credential rotation", { rotated, failed, primaryKeyId: ring.primary.id });
  return { rotated, failed, remaining, primaryKeyId: ring.primary.id };
}

/** Rows per key id (legacy v1 rows are counted under "v1"), for the admin rotation status. */
export async function credentialKeyStatus(db: Database, ring: KeyRing) {
  const rows = await db.execute<{ key_id: string; n: number }>(sql`
    select case when encrypted_key like 'v2.%' then split_part(encrypted_key, '.', 2) else 'v1' end as key_id,
      count(*)::int as n
    from (select encrypted_key from provider_credentials
          union all select encrypted_refresh_token from youtube_channels) k group by 1`);
  const byKey = Object.fromEntries([...rows].map((r) => [r.key_id, r.n]));
  const pending = [...rows].filter((r) => r.key_id !== ring.primary.id).reduce((n, r) => n + r.n, 0);
  return { primaryKeyId: ring.primary.id, configuredKeyIds: ring.ids, byKey, pending };
}

/** True for loopback, private, link-local, CGNAT, unique-local and unspecified addresses. */
export function isPrivateAddress(ip: string) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === "::1" || s === "::") return true;
    if (s.startsWith("::ffff:")) return isPrivateAddress(s.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb)/.test(s);
  }
  return true;
}

/**
 * Custom endpoints are called from inside the server's network, so only public HTTPS hosts are allowed
 * (blocks reaching postgres/redis/internal services by name or IP).
 */
export async function assertPublicHttpsUrl(
  raw: string,
  resolve: (host: string) => Promise<string[]> = defaultResolve,
  /**
   * Outside production only: lets a custom endpoint point at the compose network, which is how the bundled
   * `mock-ai` service is reached (`http://mock-ai:4010/v1`). Never set for a production instance — it is exactly
   * the check that stops a saved endpoint from reaching cloud metadata or a neighbouring container.
   */
  opts: { allowPrivate?: boolean } = {},
) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CredentialError("Base URL is not a valid URL");
  }
  if (u.username || u.password) throw new CredentialError("Base URL must not contain credentials");
  if (opts.allowPrivate) {
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new CredentialError("Base URL must use http or https");
    return u.toString().replace(/\/$/, "");
  }
  if (u.protocol !== "https:") throw new CredentialError("Base URL must use https");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [host] : await resolve(host).catch(() => [] as string[]);
  if (!addrs.length) throw new CredentialError(`Could not resolve ${host}`);
  if (addrs.some(isPrivateAddress)) throw new CredentialError("Base URL must point to a public internet address");
  return u.toString().replace(/\/$/, "");
}
const defaultResolve = async (host: string) => (await lookup(host, { all: true })).map((a) => a.address);

export class CredentialError extends Error {}

/**
 * Whether a stored key belongs to this user. Project settings can name a key (the consistency check's, the content
 * policy fallback's); in a shared project that is one member's key, which nobody else's work may run on.
 */
export async function credentialOwnedBy(db: DbOrTx, id: string, userId: string | null) {
  if (!userId) return false;
  const [row] = await db
    .select({ id: providerCredentials.id })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.id, id), eq(providerCredentials.userId, userId)));
  return Boolean(row);
}

export type CredentialSummary = {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  keyHint: string;
  lastUsedAt: Date | null;
  createdAt: Date;
};
export type ResolvedCredential = CredentialSummary & { apiKey: string; updatedAt: Date };

export class CredentialService {
  readonly ring: KeyRing;
  /** Mock mode never calls providers: keys are stored unverified and model lists come from the catalog. */
  private readonly offline: boolean;
  /** Development only (AI_ALLOW_PRIVATE_BASE_URLS), so a custom endpoint can name the bundled `mock-ai` service. */
  private readonly allowPrivateEndpoints: boolean;
  constructor(
    private readonly db: Database,
    config: AppConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.ring = new KeyRing(config);
    this.offline = config.AI_MOCK_MODE;
    this.allowPrivateEndpoints = config.AI_ALLOW_PRIVATE_BASE_URLS;
  }

  private summary(r: typeof providerCredentials.$inferSelect): CredentialSummary {
    return {
      id: r.id,
      kind: r.kind as ProviderKind,
      label: r.label,
      baseUrl: r.baseUrl,
      keyHint: r.keyHint,
      lastUsedAt: r.lastUsedAt,
      createdAt: r.createdAt,
    };
  }

  async list(userId: string) {
    const rows = await this.db
      .select()
      .from(providerCredentials)
      .where(eq(providerCredentials.userId, userId))
      .orderBy(desc(providerCredentials.createdAt));
    return rows.map((r) => this.summary(r));
  }

  /** Validates the endpoint and verifies the key by listing models before storing it. */
  async create(userId: string, input: { kind: ProviderKind; label: string; apiKey: string; baseUrl?: string | null }) {
    const cat = providerCatalog(input.kind);
    if (!cat) throw new CredentialError("Unknown provider");
    const apiKey = input.apiKey.trim();
    if (apiKey.length < 8) throw new CredentialError("API key looks too short");
    const baseUrl =
      input.kind === "openai_compatible"
        ? await assertPublicHttpsUrl(input.baseUrl ?? "", defaultResolve, {
            allowPrivate: this.allowPrivateEndpoints,
          })
        : null;
    if (!this.offline) await this.fetchModels({ kind: input.kind, baseUrl, apiKey });
    const [row] = await this.db
      .insert(providerCredentials)
      .values({
        userId,
        kind: input.kind,
        label: input.label.trim() || cat.label,
        baseUrl,
        encryptedKey: this.ring.encrypt(apiKey),
        keyHint: `…${apiKey.slice(-4)}`,
      })
      .returning();
    return this.summary(row!);
  }

  async remove(userId: string, id: string) {
    const rows = await this.db
      .delete(providerCredentials)
      .where(and(eq(providerCredentials.id, id), eq(providerCredentials.userId, userId)))
      .returning({ id: providerCredentials.id });
    return rows.length > 0;
  }

  /** Decrypts a credential for server-side use. Only the owner may use their key. */
  async resolve(id: string, userId: string | null): Promise<ResolvedCredential> {
    const [row] = await this.db.select().from(providerCredentials).where(eq(providerCredentials.id, id));
    if (!row || !userId || row.userId !== userId)
      throw new ProviderError("byok", "auth", "The selected API key no longer exists or belongs to another user", {
        retryable: false,
      });
    // Re-check a custom endpoint every time it is used: the name was public when it was saved, but DNS can be
    // repointed at an internal address afterwards, and this is the last moment before the server calls it.
    if (row.kind === "openai_compatible" && row.baseUrl && !this.offline)
      try {
        await assertPublicHttpsUrl(row.baseUrl, defaultResolve, { allowPrivate: this.allowPrivateEndpoints });
      } catch (e) {
        throw new ProviderError("byok", "invalid_request", (e as Error).message, { retryable: false });
      }
    return { ...this.summary(row), updatedAt: row.updatedAt, apiKey: this.ring.decrypt(row.encryptedKey) };
  }

  async touch(id: string) {
    await this.db.update(providerCredentials).set({ lastUsedAt: new Date() }).where(eq(providerCredentials.id, id));
  }

  /** Model ids available to a key, split by capability (best effort, merged with catalog suggestions). */
  async listModels(cred: { kind: ProviderKind; baseUrl: string | null; apiKey: string }, cap: AiCapability) {
    const cat = providerCatalog(cred.kind)!;
    const suggested = cap === "text" ? cat.textModels : cap === "image" ? cat.imageModels : cat.ttsModels;
    const all = this.offline ? [] : await this.fetchModels(cred);
    const isImage = (id: string) => /image|dall-e|imagen|flux|stable-diffusion|sdxl|seedream|recraft/i.test(id);
    const isTts = (id: string, m: { tts?: boolean }) => Boolean(m.tts) || /tts|speech|eleven_/i.test(id);
    const filtered = all.filter((m) =>
      cap === "image"
        ? isImage(m.id) || m.image
        : cap === "tts"
          ? isTts(m.id, m)
          : !isImage(m.id) && !m.image && !isTts(m.id, m),
    );
    return [...new Set([...suggested, ...filtered.map((m) => m.id)])];
  }

  private async fetchModels(cred: {
    kind: ProviderKind;
    baseUrl: string | null;
    apiKey: string;
  }): Promise<{ id: string; image: boolean; tts?: boolean }[]> {
    const cat = providerCatalog(cred.kind)!;
    const base = (cred.baseUrl ?? cat.baseUrl ?? "").replace(/\/$/, "");
    let url: string;
    let headers: Record<string, string>;
    if (cred.kind === "elevenlabs") {
      url = `${base}/v1/models`;
      headers = { "xi-api-key": cred.apiKey };
    } else if (cred.kind === "anthropic") {
      url = `${base}/v1/models?limit=1000`;
      headers = { "x-api-key": cred.apiKey, "anthropic-version": "2023-06-01" };
    } else if (cred.kind === "google") {
      url = `${base}/models?pageSize=1000`;
      headers = { "x-goog-api-key": cred.apiKey };
    } else {
      if (cred.kind === "openai_compatible")
        await assertPublicHttpsUrl(base, defaultResolve, { allowPrivate: this.allowPrivateEndpoints });
      url = `${base}/models`;
      headers = { authorization: `Bearer ${cred.apiKey}` };
    }
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    } catch (e) {
      throw new CredentialError(`Could not reach ${cat.label}: ${(e as Error).message}`);
    }
    // A validated host must answer directly: following its redirect would reach an address we never checked.
    if (res.status >= 300 && res.status < 400)
      throw new CredentialError(`${cat.label} answered with a redirect (HTTP ${res.status})`);
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) throw new CredentialError(`${cat.label} rejected the API key`);
    if (!res.ok)
      throw new CredentialError(`${cat.label} model list failed (HTTP ${res.status}): ${text.slice(0, 200)}`);
    let json: {
      data?: { id?: string; architecture?: { output_modalities?: string[] } }[];
      models?: { name?: string; supportedGenerationMethods?: string[] }[];
    } = {};
    try {
      json = JSON.parse(text);
    } catch {
      throw new CredentialError(`${cat.label} returned an unexpected model list`);
    }
    if (Array.isArray(json))
      return (json as { model_id?: string; can_do_text_to_speech?: boolean }[])
        .filter((m) => m.model_id)
        .map((m) => ({ id: m.model_id!, image: false, tts: m.can_do_text_to_speech !== false }));
    if (json.models)
      return json.models
        .filter((m) => m.name && m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({ id: m.name!.replace(/^models\//, ""), image: /image/.test(m.name!) }));
    return (json.data ?? [])
      .filter((m) => m.id)
      .map((m) => ({ id: m.id!, image: Boolean(m.architecture?.output_modalities?.includes("image")) }));
  }
}

/** Cache key for a credential + model (keys are create/delete only, so id identifies the key revision). */
export const credentialFingerprint = (c: { id: string }, model: string) =>
  createHash("sha256").update(`${c.id}:${model}`).digest("hex").slice(0, 24);
