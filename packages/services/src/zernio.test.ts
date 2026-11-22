import { expect, test } from "bun:test";
import { listZernioAccounts, ZernioError, zernioPostBody } from "./zernio.ts";

test("one post, each platform with its own fields, published now", () => {
  const body = zernioPostBody(
    {
      targets: [
        { accountId: "yt1", platform: "youtube" },
        { accountId: "tt1", platform: "tiktok" },
        { accountId: "li1", platform: "linkedin" },
      ],
      title: "x".repeat(150),
      caption: "Episode 1",
      tags: ["manhwa"],
      visibility: "unlisted",
      aiGenerated: true,
      tiktokConsent: true,
    },
    "https://media.zernio.com/v.mp4",
    "job-1",
  );
  expect(body.publishNow).toBe(true);
  expect(body.externalId).toBe("job-1");
  expect(body.mediaItems).toEqual([{ type: "video", url: "https://media.zernio.com/v.mp4" }]);
  const [yt, tt, li] = body.platforms;
  expect(yt!.platformSpecificData).toMatchObject({ visibility: "unlisted", containsSyntheticMedia: true });
  expect((yt!.platformSpecificData as { title: string }).title).toHaveLength(100);
  expect(tt!.platformSpecificData).toMatchObject({ expressConsentGiven: true, videoMadeWithAi: true });
  expect(li).toEqual({ platform: "linkedin", accountId: "li1" });
});

test("a non-JSON reply or a network failure is a ZernioError with a fixed message", async () => {
  const html = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
  await expect(listZernioAccounts("k", html)).rejects.toThrow("Zernio returned an unexpected response");
  const down = (async () => {
    throw new TypeError("connect ECONNREFUSED 10.0.0.5:443");
  }) as unknown as typeof fetch;
  const err = await listZernioAccounts("k", down).catch((e) => e);
  expect(err).toBeInstanceOf(ZernioError);
  expect(err.message).toBe("Could not reach Zernio. Try again in a moment.");
});
