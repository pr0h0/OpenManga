import { createHash } from "node:crypto";
import { installedClis } from "@openmanga/config";
import { cliMissing, PROVIDER_CATALOG, ProviderError, type ProviderKind } from "@openmanga/domain";
import {
  CHATGPT_CALLBACK_PATH,
  ChatgptAuthError,
  type ChatgptPending,
  CredentialError,
  chatgptAuthStart,
  chatgptExchange,
  chatgptReturned,
} from "@openmanga/services";
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
  if (e instanceof CredentialError || e instanceof ChatgptAuthError)
    return new ApiError(422, "credential_invalid", e.message);
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
    /** The bundled CLIs this image has; a provider whose CLI is missing is left out of `catalog`. */
    clis: installedClis(deps.config),
    catalog: PROVIDER_CATALOG.filter((p) => !cliMissing(p.kind, installedClis(deps.config))),
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
    // Only a missing key is "not found"; an expired sign-in (e.g. ChatGPT) keeps its own "connect again" message.
    if (e instanceof ProviderError && e.code === "auth" && e.provider === "byok") throw notFound("Credential");
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
    // Only a missing key is "not found"; an expired sign-in (e.g. ChatGPT) keeps its own "connect again" message.
    if (e instanceof ProviderError && e.code === "auth" && e.provider === "byok") throw notFound("Credential");
    throw asApiError(e);
  }
});

/** A started ChatGPT sign-in waits here under its state; single use, 15 minutes. */
const pendingKey = (state: string) => `chatgpt:oauth:${state}`;
/** Its outcome, so the tab that started it sees a sign-in another tab (the tunnel's) finished. */
const doneKey = (state: string) => `chatgpt:done:${state}`;

type ConnectCheck = { ok: true; model: string; reply: string; ms: number } | { ok: false; error: string };
type ChatgptDone = { userId: string; credential: unknown; check: ConnectCheck };

/** One tiny prompt through the new connection, so "connected" means a run would work. */
async function checkConnection(deps: AppEnv["Variables"]["deps"], credentialId: string, userId: string) {
  const started = performance.now();
  try {
    const p = await deps.resolver.text({ credentialId }, userId);
    const r = await p.generateText({
      messages: [{ role: "user", content: "Reply with exactly: OpenManga connected" }],
      signal: AbortSignal.timeout(60_000),
    });
    return {
      ok: true,
      model: p.model,
      reply: r.text.trim().slice(0, 200),
      ms: Math.round(performance.now() - started),
    } as const;
  } catch (e) {
    // Provider and sign-in errors are written for people; anything else (a query, a bug) is logged, not shown.
    const shown = e instanceof ProviderError || e instanceof ChatgptAuthError || e instanceof CredentialError;
    if (!shown) deps.logger.warn("chatgpt connection check failed", { error: (e as Error).message });
    return {
      ok: false,
      error: shown ? (e as Error).message.slice(0, 300) : "The test prompt failed unexpectedly.",
    } as const;
  }
}

doc({
  method: "POST",
  path: "/api/ai/chatgpt/start",
  summary:
    'Start "Sign in with ChatGPT": returns OpenAI\'s consent URL. The browser comes back to a loopback address (tunnelled to this server, or pasted into /api/ai/chatgpt/complete).',
  tag: "ai",
  body: z.object({ label: z.string().trim().max(80).default("") }),
});
aiRoutes.post("/ai/chatgpt/start", credentialLimit, async (c) => {
  const { label } = await body(c, z.object({ label: z.string().trim().max(80).default("") }));
  const deps = c.get("deps");
  const redirectUri = `http://127.0.0.1:${deps.config.CHATGPT_OAUTH_PORT}${CHATGPT_CALLBACK_PATH}`;
  // One stable id per server: ChatGPT lists each connection under the host it came from.
  const h = createHash("sha256").update(`${deps.config.SESSION_SECRET}:chatgpt-host`).digest("hex");
  const hostId = `urn:uuid:${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  const s = chatgptAuthStart({ redirectUri, hostId, appName: "OpenManga" });
  const pending: ChatgptPending = {
    userId: user(c).id,
    verifier: s.verifier,
    nonce: s.nonce,
    redirectUri,
    label,
  };
  await deps.redis.set(pendingKey(s.state), JSON.stringify(pending), "EX", 15 * 60);
  return c.json({ url: s.url, redirectUri, state: s.state });
});

doc({
  method: "POST",
  path: "/api/ai/chatgpt/complete",
  summary:
    'Finish "Sign in with ChatGPT" with the address the browser was sent back to: saves it as the caller\'s ChatGPT credential and runs one tiny prompt through it (`check`).',
  tag: "ai",
  body: z.object({ url: z.string().trim().min(10).max(8192) }),
});
aiRoutes.post("/ai/chatgpt/complete", credentialLimit, async (c) => {
  const { url } = await body(c, z.object({ url: z.string().trim().min(10).max(8192) }));
  const deps = c.get("deps");
  try {
    const returned = chatgptReturned(url);
    const raw = await deps.redis.getdel(pendingKey(returned.state));
    const p = raw ? (JSON.parse(raw) as ChatgptPending) : null;
    // Bound to the account that started it: a sign-in someone else started cannot land on your account, or yours on theirs.
    if (!p || p.userId !== user(c).id)
      throw new ChatgptAuthError("This sign-in expired or was already used. Start again.");
    const tokens = await chatgptExchange(p, returned, p.nonce);
    const credential = await deps.credentials.createChatgpt(p.userId, p.label, tokens);
    const check = await checkConnection(deps, credential.id, p.userId);
    const done: ChatgptDone = { userId: p.userId, credential, check };
    await deps.redis.set(doneKey(returned.state), JSON.stringify(done), "EX", 15 * 60);
    return c.json({ credential, check }, 201);
  } catch (e) {
    throw asApiError(e);
  }
});

doc({
  method: "GET",
  path: "/api/ai/chatgpt/status",
  summary:
    'Whether a started "Sign in with ChatGPT" (?state= from /start) is still waiting, finished (with its credential and test prompt result) or expired.',
  tag: "ai",
});
aiRoutes.get("/ai/chatgpt/status", async (c) => {
  const { state } = query(c, z.object({ state: z.string().min(16).max(200) }));
  const deps = c.get("deps");
  const done = await deps.redis.get(doneKey(state));
  if (done) {
    const d = JSON.parse(done) as ChatgptDone;
    if (d.userId !== user(c).id) throw notFound("Sign-in");
    return c.json({ status: "done", credential: d.credential, check: d.check });
  }
  const pending = await deps.redis.get(pendingKey(state));
  if (pending && (JSON.parse(pending) as ChatgptPending).userId === user(c).id) return c.json({ status: "pending" });
  return c.json({ status: "expired" });
});

/**
 * Where OpenAI sends the browser (through the loopback tunnel). The session cookie does not travel to 127.0.0.1, so
 * this only hands the address on to the account page, whose signed-in session completes it.
 */
aiRoutes.get(CHATGPT_CALLBACK_PATH.replace(/^\/api/, ""), (c) => {
  const q = new URL(c.req.url).searchParams;
  return c.redirect(c.get("deps").urls.appUrl("account", { chatgpt_return: `?${q.toString()}` }));
});
