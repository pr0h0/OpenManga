import { expect, test } from "bun:test";
import { chatgptAuthStart, chatgptExchange, chatgptRefresh, chatgptReturned } from "./chatgpt-oauth.ts";

const jwt = (c: object) => `x.${Buffer.from(JSON.stringify(c)).toString("base64url")}.y`;
const reply = (body: object, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

test("sign-in round trip: PKCE start, pasted address, exchange, refresh", async () => {
  const s = chatgptAuthStart({
    redirectUri: "http://127.0.0.1:1455/api/auth/chatgpt/callback",
    hostId: "urn:uuid:x",
    appName: "OpenManga",
  });
  const u = new URL(s.url);
  expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  expect(u.searchParams.get("scope")).toContain("chatgpt.tokens.use.direct");

  const r = chatgptReturned(
    `http://127.0.0.1:1455/api/auth/chatgpt/callback?code=c1&state=${s.state}&client_id=oaiapp_1`,
  );
  expect(r).toEqual({ code: "c1", state: s.state, clientId: "oaiapp_1" });
  expect(() => chatgptReturned("http://127.0.0.1/?error=access_denied")).toThrow("declined");
  expect(() => chatgptReturned("not a url")).toThrow("whole address");

  const pending = { userId: "u", verifier: s.verifier, nonce: s.nonce, redirectUri: "x", label: "" };
  const ok = {
    access_token: "a1",
    refresh_token: "r1",
    token_type: "Bearer",
    expires_in: 3600,
    scope: "openid chatgpt.tokens.use.direct",
    id_token: jwt({ sub: "s", email: "e@x", nonce: s.nonce }),
  };
  const t = await chatgptExchange(pending, r, s.nonce, reply(ok));
  expect(t).toMatchObject({ clientId: "oaiapp_1", accessToken: "a1", refreshToken: "r1", email: "e@x" });
  // Wrong nonce, or sharing not granted: refused.
  await expect(chatgptExchange(pending, r, "other", reply(ok))).rejects.toThrow("verified");
  await expect(chatgptExchange(pending, r, s.nonce, reply({ ...ok, scope: "openid" }))).rejects.toThrow("sharing");

  const t2 = await chatgptRefresh(t, reply({ ...ok, access_token: "a2", refresh_token: "r2", id_token: undefined }));
  expect(t2).toMatchObject({ accessToken: "a2", refreshToken: "r2", email: "e@x" });
  await expect(chatgptRefresh(t, reply({ error: "refresh_token_reused" }, 400))).rejects.toMatchObject({
    expired: true,
  });
});
