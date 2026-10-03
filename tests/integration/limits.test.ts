import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "limits", email: "limits@example.com", password: "limits pw 12" },
    201,
  );
}, 60_000);
afterAll(() => h?.stop());

const from = (ip: string) => ({ "x-real-ip": ip });

test("a session gets the signed-in ceiling; an address with no session the lower anonymous one", async () => {
  const signedIn = await alice.raw("GET", "/api/projects");
  expect(signedIn.headers.get("x-ratelimit-limit")).toBe("100000");
  const anon = await h.client().raw("GET", "/api/auth/config", undefined, from("10.1.0.1"));
  expect(anon.headers.get("x-ratelimit-limit")).toBe("50000");
});

test("guessing reader-link tokens locks that address out of reader links, and only that address", async () => {
  const anon = h.client();
  for (let i = 0; i < 30; i++)
    expect((await anon.raw("GET", `/api/public/shares/guess${i}`, undefined, from("10.2.0.1"))).status).toBe(404);
  const locked = await anon.raw("GET", "/api/public/shares/guess-more", undefined, from("10.2.0.1"));
  expect(locked.status).toBe(429);
  expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  expect((await anon.raw("GET", "/api/public/shares/guess-more", undefined, from("10.2.0.2"))).status).toBe(404);
});

test("guessed MCP tokens are capped per address; a request with no token is not a guess", async () => {
  const mcp = (ip: string, token?: string) =>
    h.app.request("http://test.local/mcp", {
      method: "POST",
      body: "{}",
      headers: {
        host: "test.local",
        "content-type": "application/json",
        ...from(ip),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  for (let i = 0; i < 25; i++) expect((await mcp("10.3.0.1")).status).toBe(401);
  for (let i = 0; i < 20; i++) expect((await mcp("10.3.0.2", `om_pat_guess${i}`)).status).toBe(401);
  expect((await mcp("10.3.0.2", "om_pat_guess-more")).status).toBe(429);
  expect((await mcp("10.3.0.1", "om_pat_first-guess")).status).toBe(401);
});

test("wrong current passwords are capped per user, then even the right one waits", async () => {
  for (let i = 0; i < 5; i++)
    expect(
      (await alice.raw("POST", "/api/auth/password", { currentPassword: `wrong ${i} pw`, newPassword: "limits pw 13" }))
        .status,
    ).toBeGreaterThanOrEqual(400);
  const locked = await alice.raw("POST", "/api/auth/password", {
    currentPassword: "limits pw 12",
    newPassword: "limits pw 13",
  });
  expect(locked.status).toBe(429);
});

test("reset tokens: ten wrong ones per address per hour", async () => {
  const anon = h.client();
  for (let i = 0; i < 10; i++)
    expect(
      (
        await anon.raw(
          "POST",
          "/api/auth/password-reset/confirm",
          { token: `not-a-real-token-${i}-xxxxxxxxxxxx`, password: "brand new pw 1" },
          from("10.4.0.1"),
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  const locked = await anon.raw(
    "POST",
    "/api/auth/password-reset/confirm",
    { token: "not-a-real-token-x-xxxxxxxxxxxx", password: "brand new pw 1" },
    from("10.4.0.1"),
  );
  expect(locked.status).toBe(429);
});
