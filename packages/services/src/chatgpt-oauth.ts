import { createHash, randomBytes } from "node:crypto";

/**
 * "Sign in with ChatGPT" for agent apps: OpenAI's token-sharing OAuth (the flow T3 Code uses). The person approves
 * OpenManga on auth.openai.com, OpenAI registers a per-connection client (`oaiapp_…`) and the access token then works
 * as a bearer key on api.openai.com/v1, drawing on their ChatGPT plan. OpenAI only redirects to a loopback address,
 * so the browser lands on http://127.0.0.1:<port>/…, which an SSH tunnel carries to the server; without one, the
 * person pastes that address into the app instead.
 */
const AUTHORIZE = "https://auth.openai.com/api/accounts/authorize";
const TOKEN = "https://auth.openai.com/api/accounts/oauth/token";
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
const SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const CHATGPT_SHARING_SCOPE = "chatgpt.tokens.use.direct";
/** Path of the callback on whatever loopback port the browser is sent to (public: the state authenticates it). */
export const CHATGPT_CALLBACK_PATH = "/api/auth/chatgpt/callback";

/** What a ChatGPT credential stores (encrypted) in place of an API key. */
export type ChatgptTokens = {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** ms epoch */
  expiresAt: number;
  email: string | null;
  subject: string;
};

/** A started sign-in, kept server-side under its state until it is completed or expires. */
export type ChatgptPending = { userId: string; verifier: string; nonce: string; redirectUri: string; label: string };

const b64 = (b: Buffer) => b.toString("base64url");

export function chatgptAuthStart(opts: { redirectUri: string; hostId: string; appName: string }) {
  const state = b64(randomBytes(32));
  const nonce = b64(randomBytes(32));
  const verifier = b64(randomBytes(64));
  const url = new URL(AUTHORIZE);
  url.search = new URLSearchParams({
    client_id: "dynamic_agent_client",
    agent_name_hint: opts.appName,
    ext_agent_host_id: opts.hostId,
    response_type: "code",
    redirect_uri: opts.redirectUri,
    scope: SCOPE,
    resource: CHATGPT_RESOURCE,
    state,
    nonce,
    code_challenge_method: "S256",
    code_challenge: b64(createHash("sha256").update(verifier).digest()),
  }).toString();
  return { url: url.toString(), state, nonce, verifier };
}

export class ChatgptAuthError extends Error {
  constructor(
    message: string,
    /** The connection is gone for good (revoked, expired refresh): sign in again. */
    readonly expired = false,
  ) {
    super(message);
  }
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
};

async function token(body: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
      signal: AbortSignal.timeout(20_000),
      redirect: "manual",
    });
  } catch {
    throw new ChatgptAuthError("ChatGPT sign-in is unreachable right now. Try again.");
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (res.ok && json.access_token && json.token_type?.toLowerCase() === "bearer") return json;
  const err = json.error ?? `HTTP ${res.status}`;
  if (body.grant_type === "refresh_token" && /invalid_grant|token_expired|refresh_token|invalid_refresh/.test(err))
    throw new ChatgptAuthError("The ChatGPT connection expired or was disconnected. Connect it again.", true);
  if (err === "invalid_grant") throw new ChatgptAuthError("This sign-in code expired or was used. Start again.");
  throw new ChatgptAuthError(`ChatGPT did not accept the sign-in (${err}).`);
}

/** The id_token came straight from the token endpoint over TLS, so its claims are read, not re-verified (OIDC 3.1.3.7). */
function claims(idToken: string | undefined): { sub?: string; email?: string; nonce?: string } {
  try {
    return JSON.parse(Buffer.from(idToken?.split(".")[1] ?? "", "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function toTokens(t: TokenResponse, clientId: string, prev?: ChatgptTokens): ChatgptTokens {
  if (!t.scope?.split(/\s+/).includes(CHATGPT_SHARING_SCOPE))
    throw new ChatgptAuthError("Token sharing was not allowed. Connect again and allow OpenManga to use your plan.");
  if (!t.refresh_token && !prev) throw new ChatgptAuthError("ChatGPT returned no refresh token. Connect again.");
  const c = claims(t.id_token);
  return {
    clientId,
    accessToken: t.access_token!,
    refreshToken: t.refresh_token ?? prev!.refreshToken,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    email: c.email ?? prev?.email ?? null,
    subject: c.sub ?? prev?.subject ?? "",
  };
}

/** Completes a sign-in from the address the browser was sent back to (its `code`, `state` and `client_id`). */
export async function chatgptExchange(
  p: ChatgptPending,
  returned: { code: string; clientId: string },
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatgptTokens> {
  if (!/^oaiapp_/.test(returned.clientId)) throw new ChatgptAuthError("This address is not from a ChatGPT sign-in.");
  const t = await token(
    {
      grant_type: "authorization_code",
      client_id: returned.clientId,
      code: returned.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: CHATGPT_RESOURCE,
    },
    fetchImpl,
  );
  if (claims(t.id_token).nonce !== nonce)
    throw new ChatgptAuthError("ChatGPT sign-in could not be verified. Start again.");
  return toTokens(t, returned.clientId);
}

export async function chatgptRefresh(prev: ChatgptTokens, fetchImpl: typeof fetch = fetch): Promise<ChatgptTokens> {
  const t = await token(
    {
      grant_type: "refresh_token",
      client_id: prev.clientId,
      refresh_token: prev.refreshToken,
      resource: CHATGPT_RESOURCE,
    },
    fetchImpl,
  );
  return toTokens(t, prev.clientId, prev);
}

/** Reads `code`, `state`, `client_id` (and an `error`) from the pasted address or the callback's query. */
export function chatgptReturned(input: string | URLSearchParams) {
  let q: URLSearchParams;
  try {
    q = typeof input === "string" ? new URL(input.trim()).searchParams : input;
  } catch {
    throw new ChatgptAuthError("Paste the whole address from the browser's address bar.");
  }
  const error = q.get("error");
  if (error)
    throw new ChatgptAuthError(error === "access_denied" ? "The ChatGPT sign-in was declined." : `ChatGPT: ${error}`);
  const code = q.get("code");
  const state = q.get("state");
  const clientId = q.get("client_id");
  if (!code || !state || !clientId)
    throw new ChatgptAuthError("That address has no sign-in code. Paste the address the browser ended on.");
  return { code, state, clientId };
}
