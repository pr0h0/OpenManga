import { PROVIDER_CATALOG, ProviderError, type ProviderKind } from "@openmanga/domain";
import { CredentialError } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { ApiError, body, notFound, query, user, uuidParam } from "../lib/http.ts";
import { rateLimit } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

export const aiRoutes = new Hono<AppEnv>();

const credentialLimit = rateLimit({ key: "byok", limit: () => 20, windowSec: 60, by: "user" });
const KINDS = PROVIDER_CATALOG.map((p) => p.kind) as [ProviderKind, ...ProviderKind[]];

const asApiError = (e: unknown) => {
  if (e instanceof CredentialError) return new ApiError(422, "credential_invalid", e.message);
  if (e instanceof ProviderError) return new ApiError(422, "credential_invalid", e.message);
  return e;
};

doc({
  method: "GET",
  path: "/api/ai/options",
  summary:
    "Model picker data: the provider catalog, the caller's saved keys (no secrets) and what the server itself can run (local TTS, and mock providers in demo mode). There are no shared provider keys.",
  tag: "ai",
});
aiRoutes.get("/ai/options", async (c) => {
  const deps = c.get("deps");
  return c.json({
    defaults: deps.providers,
    byokOnly: true,
    mockMode: deps.config.AI_MOCK_MODE,
    catalog: PROVIDER_CATALOG,
    credentials: await deps.credentials.list(user(c).id),
  });
});

const NewCredential = z.object({
  kind: z.enum(KINDS),
  label: z.string().trim().max(80).default(""),
  /** Empty for a provider that uses the server's own sign-in (catalog `auth: "server"`). */
  apiKey: z.string().trim().max(4096).default(""),
  baseUrl: z.string().trim().max(500).nullable().optional(),
});
doc({
  method: "POST",
  path: "/api/ai/credentials",
  summary: "Save an API key (verified against the provider, stored encrypted, never returned)",
  tag: "ai",
  body: NewCredential,
});
aiRoutes.post("/ai/credentials", credentialLimit, async (c) => {
  const input = await body(c, NewCredential);
  try {
    const credential = await c.get("deps").credentials.create(user(c).id, input, { admin: user(c).role === "admin" });
    return c.json({ credential }, 201);
  } catch (e) {
    throw asApiError(e);
  }
});

doc({ method: "DELETE", path: "/api/ai/credentials/:id", summary: "Delete a saved API key", tag: "ai" });
aiRoutes.delete("/ai/credentials/:id", async (c) => {
  const ok = await c.get("deps").credentials.remove(user(c).id, uuidParam(c, "id"));
  if (!ok) throw notFound("Credential");
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/ai/credentials/:id/models",
  summary: "List models available to a saved key (?capability=text|image|tts)",
  tag: "ai",
});
aiRoutes.get("/ai/credentials/:id/models", credentialLimit, async (c) => {
  const { capability } = query(c, z.object({ capability: z.enum(["text", "image", "tts"]).default("text") }));
  const deps = c.get("deps");
  try {
    const cred = await deps.credentials.resolve(uuidParam(c, "id"), user(c).id);
    return c.json({ models: await deps.credentials.listModels(cred, capability) });
  } catch (e) {
    if (e instanceof ProviderError && e.code === "auth") throw notFound("Credential");
    throw asApiError(e);
  }
});

doc({
  method: "GET",
  path: "/api/ai/voices",
  summary: "Narration voices for a voice provider (?credentialId=&model=; no credential = server default Kokoro)",
  tag: "ai",
});
aiRoutes.get("/ai/voices", credentialLimit, async (c) => {
  const q = query(c, z.object({ credentialId: z.string().uuid().optional(), model: z.string().max(200).optional() }));
  const deps = c.get("deps");
  try {
    const tts = await deps.resolver.tts(
      q.credentialId ? { credentialId: q.credentialId, model: q.model } : null,
      user(c).id,
    );
    if (!tts) return c.json({ voices: [], provider: null });
    return c.json({ voices: await tts.voices(), provider: tts.provider });
  } catch (e) {
    if (e instanceof ProviderError && e.code === "auth") throw notFound("Credential");
    throw asApiError(e);
  }
});
