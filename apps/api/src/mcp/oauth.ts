import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import {
  and,
  eq,
  gt,
  isNull,
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthAuthorizationRequests,
  oauthClients,
  oauthRefreshTokens,
  userServices,
} from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { clientIp } from "../lib/http.ts";
import { rateLimit } from "../lib/middleware.ts";
import { hashMcpToken, loadActor, mcpUrls, newToken, TOKEN_PREFIX } from "./context.ts";
import { ALL_SCOPES, isScope } from "./scopes.ts";

/**
 * OpenManga as its own OAuth 2.1 authorization server for the MCP resource at /mcp.
 *
 * Public clients only (no secrets). Clients identify themselves either by a Client ID Metadata Document (CIMD: the
 * client id is an https URL of a JSON document, how ChatGPT prefers to connect) or by Dynamic Client Registration.
 * Codes need PKCE S256, redirects must match exactly, every request names this resource, and tokens are opaque
 * values stored only as hashes.
 */
export const oauthRoutes = new Hono<AppEnv>();

// Public clients, no cookies: browser-based clients (the MCP Inspector) may call the token endpoints directly.
oauthRoutes.use("/oauth/*", async (c, next) => {
  if (c.req.path === "/oauth/authorize") return next();
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-headers", "content-type, authorization");
  c.header("access-control-allow-methods", "POST, OPTIONS");
  if (c.req.method === "OPTIONS") return c.body(null, 204);
  await next();
});

const CIMD_MAX_BYTES = 64 * 1024;
const CIMD_TIMEOUT_MS = 5000;
const CIMD_TTL_MS = 24 * 60 * 60 * 1000;
const AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

type OAuthErr = { error: string; error_description: string };
const oauthError = (c: Context<AppEnv>, status: 400 | 401 | 403, error: string, description: string) => {
  c.header("cache-control", "no-store");
  return c.json({ error, error_description: description } satisfies OAuthErr, status);
};

// ---------------------------------------------------------------- metadata

function protectedResourceMetadata(deps: Deps) {
  const u = mcpUrls(deps.config);
  return {
    resource: u.resource,
    authorization_servers: [u.issuer],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "OpenManga",
    resource_documentation: u.docs,
  };
}

function authorizationServerMetadata(deps: Deps) {
  const u = mcpUrls(deps.config);
  return {
    issuer: u.issuer,
    authorization_endpoint: u.authorize,
    token_endpoint: u.token,
    registration_endpoint: u.register,
    revocation_endpoint: u.revoke,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ALL_SCOPES,
    service_documentation: u.docs,
  };
}

const metadata = (build: (d: Deps) => object) => (c: Context<AppEnv>) => {
  c.header("access-control-allow-origin", "*");
  c.header("cache-control", "public, max-age=300");
  return c.json(build(c.get("deps")));
};
// The bare path and the RFC 9728 / RFC 8414 path-inserted forms ("/.well-known/…/mcp") serve the same document.
oauthRoutes.get("/.well-known/oauth-protected-resource", metadata(protectedResourceMetadata));
oauthRoutes.get("/.well-known/oauth-protected-resource/*", metadata(protectedResourceMetadata));
oauthRoutes.get("/.well-known/oauth-authorization-server", metadata(authorizationServerMetadata));
oauthRoutes.get("/.well-known/oauth-authorization-server/*", metadata(authorizationServerMetadata));

// ---------------------------------------------------------------- clients

type Client = typeof oauthClients.$inferSelect;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** A redirect URI a client may register: absolute, no fragment, no wildcard; https, or http on loopback only. */
function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 2000 || raw.includes("*")) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname);
}

/** Whether an address is private, loopback, link-local or otherwise not a public destination. */
export function isPrivateAddress(ip: string) {
  const v = ip.replace(/^::ffff:/i, "");
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  const l = v.toLowerCase();
  return (
    l === "::" ||
    l === "::1" ||
    l.startsWith("fc") ||
    l.startsWith("fd") ||
    l.startsWith("fe8") ||
    l.startsWith("fe9") ||
    l.startsWith("fea") ||
    l.startsWith("feb")
  );
}

/**
 * GETs `url` from exactly `address` (an address already checked), while TLS still verifies the certificate against
 * the URL's hostname (SNI) and the request carries its Host header. Connecting by the checked address rather than
 * by name closes the DNS-rebinding window between the check and the connection. No redirects, a size cap, a timeout.
 */
function pinnedGet(url: URL, address: string): Promise<{ status: number; body: Uint8Array }> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        host: address,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: "GET",
        servername: isIP(url.hostname) ? undefined : url.hostname,
        headers: { host: url.host, accept: "application/json" },
        agent: false,
        timeout: CIMD_TIMEOUT_MS,
      },
      (res) => {
        if (Number(res.headers["content-length"] ?? 0) > CIMD_MAX_BYTES) {
          res.destroy();
          return reject(new Error("client metadata is too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (d: Buffer) => {
          size += d.length;
          if (size > CIMD_MAX_BYTES) {
            res.destroy();
            reject(new Error("client metadata is too large"));
          } else chunks.push(d);
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: new Uint8Array(Buffer.concat(chunks)) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("client metadata timed out")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Fetches a Client ID Metadata Document without letting the client id aim the server at the inside of its own
 * network: https only, every resolved address public, the connection pinned to a checked address, no redirects, a
 * size cap and a timeout.
 */
export async function fetchClientMetadata(deps: Deps, clientId: string): Promise<Record<string, unknown>> {
  const url = new URL(clientId);
  const allowPrivate = deps.config.MCP_CIMD_ALLOW_PRIVATE;
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:"))
    throw new Error("client_id must be an https URL");
  if (url.hash || url.username || url.password) throw new Error("client_id must be a plain URL");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (!addresses.length) throw new Error("client_id does not resolve");
  if (!allowPrivate && addresses.some(isPrivateAddress)) throw new Error("client_id resolves to a private address");
  const res = await pinnedGet(url, addresses[0]!);
  if (res.status !== 200) throw new Error(`client metadata answered ${res.status}`);
  const doc = JSON.parse(new TextDecoder().decode(res.body)) as unknown;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("client metadata is not an object");
  return doc as Record<string, unknown>;
}

/** Validates client metadata (from CIMD or DCR) into what this server stores: a name and exact redirect URIs. */
function parseClientMetadata(doc: Record<string, unknown>, opts: { requireNone: boolean }) {
  const uris = doc.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every(validRedirectUri))
    throw new Error(
      "redirect_uris must be 1-10 absolute https URLs (http only on loopback), without fragments or wildcards",
    );
  const supported = Array.isArray(doc.token_endpoint_auth_methods_supported)
    ? (doc.token_endpoint_auth_methods_supported as unknown[])
    : [];
  const single = doc.token_endpoint_auth_method;
  if (opts.requireNone && single !== undefined && single !== "none" && !supported.includes("none"))
    throw new Error('only public clients are supported (token_endpoint_auth_method "none")');
  for (const g of Array.isArray(doc.grant_types) ? doc.grant_types : [])
    if (g !== "authorization_code" && g !== "refresh_token") throw new Error(`unsupported grant type ${String(g)}`);
  const name =
    typeof doc.client_name === "string" && doc.client_name.trim() ? doc.client_name.trim().slice(0, 100) : null;
  return { name, redirectUris: uris as string[] };
}

/** The client a request names: a registered one, or a CIMD document fetched (and cached for a day). */
export async function resolveClient(deps: Deps, clientId: string): Promise<Client | null> {
  if (!clientId || clientId.length > 2000) return null;
  const [known] = await deps.db.select().from(oauthClients).where(eq(oauthClients.id, clientId));
  const cimd = /^https?:\/\//i.test(clientId);
  if (!cimd) return known ?? null;
  if (known?.fetchedAt && Date.now() - known.fetchedAt.getTime() < CIMD_TTL_MS) return known;
  try {
    const doc = await fetchClientMetadata(deps, clientId);
    if (doc.client_id !== clientId) throw new Error("client_id in the document does not match its URL");
    const meta = parseClientMetadata(doc, { requireNone: true });
    const values = {
      id: clientId,
      kind: "cimd" as const,
      name: meta.name ?? new URL(clientId).hostname,
      redirectUris: meta.redirectUris,
      metadata: { client_uri: doc.client_uri, logo_uri: doc.logo_uri },
      fetchedAt: new Date(),
    };
    const [row] = await deps.db
      .insert(oauthClients)
      .values(values)
      .onConflictDoUpdate({ target: oauthClients.id, set: values })
      .returning();
    return row ?? null;
  } catch (e) {
    deps.logger.warn("cimd client rejected", { clientId, error: e instanceof Error ? e.message : String(e) });
    // A document that stopped validating does not keep a stale grant alive.
    return null;
  }
}

oauthRoutes.post(
  "/oauth/register",
  rateLimit({ key: "oauth-register", limit: () => 20, windowSec: 3600, by: "ip" }),
  async (c) => {
    let doc: Record<string, unknown>;
    try {
      doc = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return oauthError(c, 400, "invalid_client_metadata", "Body must be a JSON object");
    }
    let meta: ReturnType<typeof parseClientMetadata>;
    try {
      meta = parseClientMetadata(doc, { requireNone: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return oauthError(
        c,
        400,
        msg.startsWith("redirect_uris") ? "invalid_redirect_uri" : "invalid_client_metadata",
        msg,
      );
    }
    const id = `oc_${randomBytes(18).toString("base64url")}`;
    const name = meta.name ?? "MCP client";
    await c
      .get("deps")
      .db.insert(oauthClients)
      .values({ id, kind: "dcr", name, redirectUris: meta.redirectUris, metadata: { ip: clientIp(c) } });
    c.header("cache-control", "no-store");
    return c.json(
      {
        client_id: id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: name,
        redirect_uris: meta.redirectUris,
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      },
      201,
    );
  },
);

// ---------------------------------------------------------------- authorize

const errorPage = (c: Context<AppEnv>, message: string) =>
  c.html(
    `<!doctype html><meta charset="utf-8"><title>Authorization error</title><body style="font:15px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem"><h1>Cannot connect</h1><p>${message.replace(/[&<>"]/g, (ch) => `&#${ch.charCodeAt(0)};`)}</p><p>Close this window and try connecting again from your app.</p></body>`,
    400,
  );

/** Where an authorization ends: back at the client with the result, its state and this issuer (RFC 9207). */
export function redirectBack(
  deps: Deps,
  redirectUri: string,
  params: Record<string, string>,
  state: string | null,
): string {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (state !== null) url.searchParams.set("state", state);
  url.searchParams.set("iss", mcpUrls(deps.config).issuer);
  return url.toString();
}

const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

oauthRoutes.get(
  "/oauth/authorize",
  rateLimit({ key: "oauth-authorize", limit: () => 60, windowSec: 60, by: "ip" }),
  async (c) => {
    const deps = c.get("deps");
    const q = c.req.query();
    const client = await resolveClient(deps, q.client_id ?? "");
    // Until the client and its redirect are verified, errors go to the browser, never to an unverified redirect.
    if (!client) return errorPage(c, "This app is not registered with this OpenManga server.");
    const redirectUri = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
    if (!redirectUri || !client.redirectUris.includes(redirectUri))
      return errorPage(c, "The app asked to return to an address it did not register.");
    const state = q.state ?? null;
    const fail = (error: string, description: string) =>
      c.redirect(redirectBack(deps, redirectUri, { error, error_description: description }, state), 302);
    if (q.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported");
    if (q.code_challenge_method !== "S256" || !PKCE_CHALLENGE.test(q.code_challenge ?? ""))
      return fail("invalid_request", "PKCE with code_challenge_method=S256 is required");
    const resource = (q.resource ?? "").replace(/\/$/, "");
    if (resource !== mcpUrls(deps.config).resource)
      return fail("invalid_target", `resource must be ${mcpUrls(deps.config).resource}`);
    const asked = (q.scope ?? "").split(/\s+/).filter(Boolean);
    const known = asked.filter(isScope);
    if (asked.length && !known.length) return fail("invalid_scope", "None of the requested scopes exist");
    const [req] = await deps.db
      .insert(oauthAuthorizationRequests)
      .values({
        clientId: client.id,
        redirectUri,
        state,
        codeChallenge: q.code_challenge!,
        resource,
        // Nothing asked for means the client leaves the choice to the user: offer every scope.
        scopes: known.length ? known : ALL_SCOPES,
        expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
      })
      .returning({ id: oauthAuthorizationRequests.id });
    // The consent page (in the web app, behind the normal login) only ever sees this id.
    return c.redirect(deps.urls.appUrl(`connect/${req!.id}`), 302);
  },
);

// ---------------------------------------------------------------- token

const sha256b64url = (v: string) => createHash("sha256").update(v).digest("base64url");
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

async function readForm(c: Context<AppEnv>): Promise<Record<string, string>> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/json")) {
    const j = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : String(v)]));
  }
  const f = await c.req.parseBody().catch(() => ({}));
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
}

/** Issues an access token and the next refresh token of a family. */
async function issueTokens(
  deps: Deps,
  g: { serviceId: string; clientId: string; familyId: string; resource: string; scopes: string[] },
) {
  const access = newToken(TOKEN_PREFIX.access);
  const refresh = newToken(TOKEN_PREFIX.refresh);
  const ttl = deps.config.MCP_ACCESS_TOKEN_TTL_MINUTES * 60;
  await deps.db.insert(oauthAccessTokens).values({
    tokenHash: hashMcpToken(deps.config, access),
    serviceId: g.serviceId,
    clientId: g.clientId,
    familyId: g.familyId,
    resource: g.resource,
    scopes: g.scopes,
    expiresAt: new Date(Date.now() + ttl * 1000),
  });
  await deps.db.insert(oauthRefreshTokens).values({
    tokenHash: hashMcpToken(deps.config, refresh),
    familyId: g.familyId,
    serviceId: g.serviceId,
    clientId: g.clientId,
    resource: g.resource,
    scopes: g.scopes,
    expiresAt: new Date(Date.now() + deps.config.MCP_REFRESH_TOKEN_TTL_DAYS * 86_400_000),
  });
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ttl,
    refresh_token: refresh,
    scope: g.scopes.join(" "),
  };
}

/** Revokes every token of a connection, or of one family, now. */
export async function revokeTokens(deps: Deps, by: { serviceId?: string; familyId?: string }) {
  const now = new Date();
  const refreshWhere = by.familyId
    ? eq(oauthRefreshTokens.familyId, by.familyId)
    : eq(oauthRefreshTokens.serviceId, by.serviceId!);
  const accessWhere = by.familyId
    ? eq(oauthAccessTokens.familyId, by.familyId)
    : eq(oauthAccessTokens.serviceId, by.serviceId!);
  await deps.db
    .update(oauthRefreshTokens)
    .set({ revokedAt: now })
    .where(and(refreshWhere, isNull(oauthRefreshTokens.revokedAt)));
  await deps.db
    .update(oauthAccessTokens)
    .set({ revokedAt: now })
    .where(and(accessWhere, isNull(oauthAccessTokens.revokedAt)));
}

oauthRoutes.post(
  "/oauth/token",
  rateLimit({ key: "oauth-token", limit: () => 60, windowSec: 60, by: "ip" }),
  async (c) => {
    const deps = c.get("deps");
    const f = await readForm(c);
    c.header("pragma", "no-cache");
    const clientId = f.client_id ?? "";
    const client = clientId ? await resolveClient(deps, clientId) : null;
    if (!client) return oauthError(c, 401, "invalid_client", "Unknown client");
    const resourceIn = (f.resource ?? "").replace(/\/$/, "");
    const resource = mcpUrls(deps.config).resource;

    if (f.grant_type === "authorization_code") {
      if (!resourceIn) return oauthError(c, 400, "invalid_target", "resource is required");
      if (resourceIn !== resource) return oauthError(c, 400, "invalid_target", "resource does not match this server");
      if (!VERIFIER.test(f.code_verifier ?? ""))
        return oauthError(c, 400, "invalid_request", "A valid code_verifier is required");
      const codeHash = hashMcpToken(deps.config, f.code ?? "");
      const [code] = await deps.db
        .select()
        .from(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, codeHash));
      if (!code) return oauthError(c, 400, "invalid_grant", "Unknown authorization code");
      if (code.usedAt) {
        // A code presented twice was intercepted or replayed: cut the connection it produced.
        await revokeTokens(deps, { serviceId: code.serviceId });
        await recordAudit(deps.db, {
          action: "oauth.code_reuse",
          targetType: "user_service",
          targetId: code.serviceId,
          serviceId: code.serviceId,
          ip: clientIp(c),
        });
        return oauthError(c, 400, "invalid_grant", "Authorization code already used");
      }
      if (code.expiresAt.getTime() < Date.now())
        return oauthError(c, 400, "invalid_grant", "Authorization code expired");
      if (code.clientId !== client.id) return oauthError(c, 400, "invalid_grant", "Code was issued to another client");
      if (code.redirectUri !== (f.redirect_uri ?? ""))
        return oauthError(c, 400, "invalid_grant", "redirect_uri does not match");
      if (code.resource !== resourceIn)
        return oauthError(c, 400, "invalid_target", "resource does not match the authorization");
      if (sha256b64url(f.code_verifier!) !== code.codeChallenge)
        return oauthError(c, 400, "invalid_grant", "PKCE verification failed");
      const [claimed] = await deps.db
        .update(oauthAuthorizationCodes)
        .set({ usedAt: new Date() })
        .where(and(eq(oauthAuthorizationCodes.codeHash, codeHash), isNull(oauthAuthorizationCodes.usedAt)))
        .returning();
      if (!claimed) return oauthError(c, 400, "invalid_grant", "Authorization code already used");
      const actor = await loadActor(deps.db, code.serviceId);
      if (!actor) return oauthError(c, 400, "invalid_grant", "The connection is no longer active");
      const scopes = code.scopes.filter((s) => actor.scopes.has(s as never));
      return c.json(
        await issueTokens(deps, {
          serviceId: code.serviceId,
          clientId: client.id,
          familyId: crypto.randomUUID(),
          resource,
          scopes,
        }),
      );
    }

    if (f.grant_type === "refresh_token") {
      if (resourceIn && resourceIn !== resource)
        return oauthError(c, 400, "invalid_target", "resource does not match this server");
      const hash = hashMcpToken(deps.config, f.refresh_token ?? "");
      const [rt] = await deps.db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hash));
      if (!rt || rt.clientId !== client.id) return oauthError(c, 400, "invalid_grant", "Unknown refresh token");
      if (rt.revokedAt) return oauthError(c, 400, "invalid_grant", "Refresh token revoked");
      const reuse = async () => {
        await revokeTokens(deps, { familyId: rt.familyId });
        await recordAudit(deps.db, {
          action: "oauth.refresh_reuse",
          targetType: "user_service",
          targetId: rt.serviceId,
          serviceId: rt.serviceId,
          metadata: { familyId: rt.familyId },
          ip: clientIp(c),
        });
        return oauthError(
          c,
          400,
          "invalid_grant",
          "Refresh token already used; the session was revoked, sign in again",
        );
      };
      if (rt.usedAt) return reuse();
      if (rt.expiresAt.getTime() < Date.now()) return oauthError(c, 400, "invalid_grant", "Refresh token expired");
      const [claimed] = await deps.db
        .update(oauthRefreshTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(oauthRefreshTokens.tokenHash, hash),
            isNull(oauthRefreshTokens.usedAt),
            isNull(oauthRefreshTokens.revokedAt),
          ),
        )
        .returning();
      if (!claimed) return reuse();
      const actor = await loadActor(deps.db, rt.serviceId);
      if (!actor) return oauthError(c, 400, "invalid_grant", "The connection is no longer active");
      const asked = (f.scope ?? "").split(/\s+/).filter(Boolean);
      const scopes = rt.scopes.filter((s) => actor.scopes.has(s as never) && (!asked.length || asked.includes(s)));
      return c.json(
        await issueTokens(deps, {
          serviceId: rt.serviceId,
          clientId: client.id,
          familyId: rt.familyId,
          resource,
          scopes,
        }),
      );
    }

    return oauthError(c, 400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
  },
);

oauthRoutes.post(
  "/oauth/revoke",
  rateLimit({ key: "oauth-revoke", limit: () => 60, windowSec: 60, by: "ip" }),
  async (c) => {
    const deps = c.get("deps");
    const f = await readForm(c);
    const hash = hashMcpToken(deps.config, f.token ?? "");
    const [rt] = await deps.db.select().from(oauthRefreshTokens).where(eq(oauthRefreshTokens.tokenHash, hash));
    if (rt && (!f.client_id || rt.clientId === f.client_id)) await revokeTokens(deps, { familyId: rt.familyId });
    const [at] = await deps.db.select().from(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, hash));
    if (at && (!f.client_id || at.clientId === f.client_id))
      await deps.db
        .update(oauthAccessTokens)
        .set({ revokedAt: new Date() })
        .where(eq(oauthAccessTokens.tokenHash, hash));
    // RFC 7009: the answer is the same whether or not the token existed.
    return c.body(null, 200);
  },
);

// ---------------------------------------------------------------- consent (called by the web app, session-authenticated)

export type ConsentGrant = {
  name: string;
  scopes: string[];
  projectAccess: "all" | "selected";
  projectIds: string[];
  allowProjectCreate: boolean;
  approvalMode: "ALLOW_ALL" | "REQUIRE_APPROVAL";
};

/** The frozen request, if it is still open, with its client. */
export async function openAuthorizationRequest(deps: Deps, id: string) {
  const [req] = await deps.db
    .select({ r: oauthAuthorizationRequests, client: oauthClients })
    .from(oauthAuthorizationRequests)
    .innerJoin(oauthClients, eq(oauthClients.id, oauthAuthorizationRequests.clientId))
    .where(
      and(
        eq(oauthAuthorizationRequests.id, id),
        isNull(oauthAuthorizationRequests.completedAt),
        gt(oauthAuthorizationRequests.expiresAt, new Date()),
      ),
    );
  return req ?? null;
}

/** Closes a request so it cannot be answered twice. False when it was already answered or has expired. */
async function closeRequest(deps: Deps, id: string) {
  const [row] = await deps.db
    .update(oauthAuthorizationRequests)
    .set({ completedAt: new Date() })
    .where(and(eq(oauthAuthorizationRequests.id, id), isNull(oauthAuthorizationRequests.completedAt)))
    .returning({ id: oauthAuthorizationRequests.id });
  return Boolean(row);
}

/**
 * The user approved: create (or update) their connection for this client and hand the client a one-time code.
 * Re-authorizing the same client updates the existing connection and revokes its earlier tokens, instead of
 * piling up duplicate connections every time the client signs in again.
 */
export async function approveAuthorization(
  deps: Deps,
  userId: string,
  requestId: string,
  grant: ConsentGrant,
  saveProjects: (serviceId: string) => Promise<void>,
) {
  const req = await openAuthorizationRequest(deps, requestId);
  if (!req || !(await closeRequest(deps, requestId))) return null;
  const scopes = req.r.scopes.filter((s) => grant.scopes.includes(s) && isScope(s));
  const [existing] = await deps.db
    .select()
    .from(userServices)
    .where(
      and(
        eq(userServices.userId, userId),
        eq(userServices.kind, "oauth"),
        eq(userServices.clientId, req.client.id),
        isNull(userServices.revokedAt),
      ),
    );
  const values = {
    name: grant.name.trim().slice(0, 100) || req.client.name,
    scopes,
    projectAccess: grant.projectAccess,
    allowProjectCreate: grant.allowProjectCreate,
    approvalMode: grant.approvalMode,
    updatedAt: new Date(),
  };
  const serviceId = existing
    ? (await deps.db.update(userServices).set(values).where(eq(userServices.id, existing.id)).returning())[0]!.id
    : (
        await deps.db
          .insert(userServices)
          .values({
            ...values,
            userId,
            kind: "oauth",
            clientId: req.client.id,
            metadata: { clientName: req.client.name },
          })
          .returning()
      )[0]!.id;
  if (existing) await revokeTokens(deps, { serviceId });
  await saveProjects(serviceId);
  const code = newToken(TOKEN_PREFIX.code);
  await deps.db.insert(oauthAuthorizationCodes).values({
    codeHash: hashMcpToken(deps.config, code),
    clientId: req.client.id,
    serviceId,
    redirectUri: req.r.redirectUri,
    codeChallenge: req.r.codeChallenge,
    resource: req.r.resource,
    scopes,
    expiresAt: new Date(Date.now() + deps.config.MCP_AUTH_CODE_TTL_SECONDS * 1000),
  });
  await recordAudit(deps.db, {
    userId,
    action: existing ? "oauth.reauthorize" : "oauth.authorize",
    targetType: "user_service",
    targetId: serviceId,
    serviceId,
    metadata: { client: req.client.name, scopes, projectAccess: grant.projectAccess, approvalMode: grant.approvalMode },
  });
  return { serviceId, redirectTo: redirectBack(deps, req.r.redirectUri, { code }, req.r.state) };
}

/** The user said no: the client learns it was denied, nothing is created. */
export async function denyAuthorization(deps: Deps, requestId: string) {
  const req = await openAuthorizationRequest(deps, requestId);
  if (!req || !(await closeRequest(deps, requestId))) return null;
  return {
    redirectTo: redirectBack(
      deps,
      req.r.redirectUri,
      { error: "access_denied", error_description: "The user declined the connection" },
      req.r.state,
    ),
  };
}
