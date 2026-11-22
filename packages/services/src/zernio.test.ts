import { expect, test } from "bun:test";
import { zernioPostBody } from "./zernio.ts";

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
