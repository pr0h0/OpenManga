import { describe, expect, test } from "bun:test";
import { HttpYouTubeClient, type YouTubeError } from "./youtube-client.ts";

const stub = (status: number, body: unknown, seen: Request[] = []) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;

describe("HttpYouTubeClient", () => {
  test("consent URL asks for offline, read-only access with PKCE", () => {
    const u = new URL(
      new HttpYouTubeClient("cid", "secret").authUrl({ state: "s", redirectUri: "https://x/cb", codeChallenge: "c" }),
    );
    expect(u.host).toBe("accounts.google.com");
    expect(u.searchParams.get("scope")).toBe(
      "https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly",
    );
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
  });

  test("errors are classified: revoked grant, quota, API not enabled", async () => {
    const run = (status: number, body: unknown) =>
      new HttpYouTubeClient("c", "s", stub(status, body)).refresh("r").catch((e: YouTubeError) => e.code);
    expect(await run(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." })).toBe(
      "revoked",
    );
    expect(await run(403, { error: { message: "x", errors: [{ reason: "quotaExceeded" }] } })).toBe("quota");
    expect(
      await run(403, {
        error: { message: "YouTube Reporting API has not been used in project 1", status: "PERMISSION_DENIED" },
      }),
    ).toBe("not_enabled");
  });

  test("videos are read with the API key or the bearer token, counters parsed", async () => {
    const seen: Request[] = [];
    const c = new HttpYouTubeClient(
      "c",
      "s",
      stub(
        200,
        {
          items: [
            {
              id: "dQw4w9WgXcQ",
              snippet: { channelId: "UC1", channelTitle: "Ch", title: "T", publishedAt: "2026-10-01T00:00:00Z" },
              contentDetails: { duration: "PT3M33S" },
              statistics: { viewCount: "10", likeCount: "2" },
            },
          ],
        },
        seen,
      ),
    );
    const [v] = await c.videos(["dQw4w9WgXcQ"], { apiKey: "k" });
    expect(v).toMatchObject({ views: 10, likes: 2, comments: null, durationSeconds: 213 });
    expect(new URL(seen[0]!.url).searchParams.get("key")).toBe("k");
    await c.videos(["dQw4w9WgXcQ"], { accessToken: "t" });
    expect(seen[1]!.headers.get("authorization")).toBe("Bearer t");
  });

  test("a report is only downloaded from Google's report host", async () => {
    const c = new HttpYouTubeClient("c", "s", stub(200, "date\n"));
    await expect(c.downloadReport("t", "https://evil.example/report")).rejects.toThrow(
      "Unexpected report download host",
    );
    expect(await c.downloadReport("t", "https://youtubereporting.googleapis.com/v1/media/x?alt=media")).toBe("date\n");
  });
});

describe("FakeYouTubeClient", () => {
  test("the newest upload is always in its first 48 hours, with a day of Analytics, at any time of day", async () => {
    const { FakeYouTubeClient } = await import("./youtube-client.ts");
    for (const at of ["2026-10-08T00:01:00Z", "2026-10-08T23:59:00Z", "2026-10-09T12:00:00Z"]) {
      const now = new Date(at);
      const fake = new FakeYouTubeClient("http://x/consent", () => now);
      const { accessToken } = await fake.exchangeCode({ code: "fake.Chan" });
      const [first] = (await fake.uploads(accessToken, `UU${FakeYouTubeClient.prefix("Chan")}`)).items;
      const age = now.getTime() - Date.parse(first!.publishedAt!);
      expect(age).toBeGreaterThanOrEqual(24 * 3600_000);
      expect(age).toBeLessThan(48 * 3600_000);
      const yesterday = new Date(now.getTime() - 86400_000).toISOString().slice(0, 10);
      const daily = await fake.analytics(accessToken, {
        videoId: first!.videoId,
        startDate: first!.publishedAt!.slice(0, 10),
        endDate: yesterday,
        metrics: ["views"],
        dimension: "day",
      });
      expect(daily.rows.length).toBe(1);
    }
  });
});
