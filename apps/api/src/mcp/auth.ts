import { and, eq, isNull, oauthAccessTokens, personalAccessTokens, sql, userServices } from "@openmanga/db";
import type { Deps } from "../context.ts";
import { hashMcpToken, loadActor, type McpActor, mcpUrls, TOKEN_PREFIX } from "./context.ts";

export type BearerResult = { actor: McpActor; expiresAt?: number } | { error: "missing" | "invalid" };

/** Touches last-used at most once a minute, so a busy agent does not write on every call. */
const touch = (deps: Deps, serviceId: string) =>
  deps.db
    .update(userServices)
    .set({ lastUsedAt: new Date() })
    .where(
      and(
        eq(userServices.id, serviceId),
        sql`(${userServices.lastUsedAt} is null or ${userServices.lastUsedAt} < now() - interval '1 minute')`,
      ),
    );

/**
 * Resolves `Authorization: Bearer …` to an actor: a personal access token (`om_pat_`) or an OAuth access token
 * (`om_mcp_at_`) bound to this resource. Both end at the same connection, loaded fresh, so a revoked connection, a
 * disabled user or narrowed scopes apply on the next call whatever the token says.
 */
export async function authenticateBearer(deps: Deps, header: string | undefined): Promise<BearerResult> {
  const m = /^Bearer\s+(\S+)$/i.exec(header?.trim() ?? "");
  if (!m) return { error: "missing" };
  const token = m[1]!;
  const hash = hashMcpToken(deps.config, token);
  const now = new Date();

  if (token.startsWith(TOKEN_PREFIX.pat)) {
    const [pat] = await deps.db
      .select()
      .from(personalAccessTokens)
      .where(and(eq(personalAccessTokens.tokenHash, hash), isNull(personalAccessTokens.revokedAt)));
    if (!pat || (pat.expiresAt && pat.expiresAt < now)) return { error: "invalid" };
    const actor = await loadActor(deps.db, pat.serviceId);
    if (!actor) return { error: "invalid" };
    await Promise.all([
      touch(deps, actor.serviceId),
      deps.db
        .update(personalAccessTokens)
        .set({ lastUsedAt: now })
        .where(
          and(
            eq(personalAccessTokens.id, pat.id),
            sql`(${personalAccessTokens.lastUsedAt} is null or ${personalAccessTokens.lastUsedAt} < now() - interval '1 minute')`,
          ),
        ),
    ]);
    return { actor, expiresAt: pat.expiresAt ? Math.floor(pat.expiresAt.getTime() / 1000) : undefined };
  }

  if (token.startsWith(TOKEN_PREFIX.access)) {
    const [at] = await deps.db
      .select()
      .from(oauthAccessTokens)
      .where(and(eq(oauthAccessTokens.tokenHash, hash), isNull(oauthAccessTokens.revokedAt)));
    // Audience binding: a token minted for another resource is not accepted here.
    if (!at || at.expiresAt < now || at.resource !== mcpUrls(deps.config).resource) return { error: "invalid" };
    const actor = await loadActor(deps.db, at.serviceId, at.scopes);
    if (!actor || actor.clientId !== at.clientId) return { error: "invalid" };
    await touch(deps, actor.serviceId);
    return { actor, expiresAt: Math.floor(at.expiresAt.getTime() / 1000) };
  }
  return { error: "invalid" };
}

/** The RFC 6750 / RFC 9728 challenge that sends an OAuth client to discover how to sign in. */
export function bearerChallenge(deps: Deps, error?: { code: string; description: string; scope?: string }) {
  const parts = [`resource_metadata="${mcpUrls(deps.config).resourceMetadata}"`];
  if (error) {
    parts.push(`error="${error.code}"`, `error_description="${error.description.replace(/["\\]/g, "")}"`);
    if (error.scope) parts.push(`scope="${error.scope}"`);
  }
  return `Bearer ${parts.join(", ")}`;
}
