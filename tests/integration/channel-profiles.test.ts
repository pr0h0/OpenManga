import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
let alice: TestClient;
let bob: TestClient;

type Settings = {
  narrationVoice: string;
  narrationSpeed: number;
  pronunciation?: { term: string; spoken: string }[];
  imageQuality: string;
  batchPolicy: string;
  referencePolicy: string;
  format: string;
  targetRuntime?: { minutes: number } | null;
  thumbnailStyle?: { side: string };
  youtubeRules?: { titleRules: string; descriptionTemplate: string; tags: string[] };
  youtubePackage?: { titles: string[]; description: string; tags: string[] };
  channelProfile?: { id: string; name: string } | null;
  video?: {
    watermark?: { assetId: string; corner: string; opacity: number } | null;
    intro?: { title: string } | null;
    output?: { aspect: string; height: number };
  };
};
type Profile = { id: string; name: string; preset: string | null; settings: Partial<Settings> };
type Project = { id: string; projectType: string; settings: Settings };
type Change = { key: string; from: unknown; to: unknown };

const logoPng = async (color: string) =>
  new Uint8Array(
    await sharp({ create: { width: 64, height: 32, channels: 4, background: color } })
      .png()
      .toBuffer(),
  );
async function upload(c: TestClient, path: string, color: string) {
  const form = new FormData();
  form.set("file", new File([(await logoPng(color)) as BlobPart], "logo.png", { type: "image/png" }));
  return c.json<{ asset: { id: string } }>("POST", path, form, 201);
}
const assetRow = async (id: string) =>
  (
    await h.deps.db.execute<{ project_id: string | null; owner_user_id: string; sha256: string }>(
      sql`select project_id, owner_user_id, sha256 from assets where id = ${id}`,
    )
  )[0];

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "chan", email: "chan@example.com", password: "channel pass 1" },
    201,
  );
  await bob.post(
    "/api/auth/register",
    { username: "other", email: "other@example.com", password: "channel pass 2" },
    201,
  );
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

describe("channel profiles", () => {
  let profile: Profile;
  let projectId = "";

  test("a profile is created with its own logo, owned by the account and no project", async () => {
    const logo = await upload(alice, "/api/channel-profiles/logo", "#ff0000");
    expect((await assetRow(logo.asset.id))?.project_id).toBeNull();
    // Someone else's logo can't be the watermark, nor can a made-up id.
    const bobLogo = await upload(bob, "/api/channel-profiles/logo", "#00ff00");
    const settings = {
      narrationVoice: "am_adam",
      narrationSpeed: 1.2,
      pronunciation: [{ term: "Qi", spoken: "chee" }],
      imageQuality: "medium",
      referencePolicy: "main",
      batchPolicy: "images",
      targetRuntime: { minutes: 45, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 9 },
      thumbnailStyle: { side: "right" },
      youtubeRules: {
        titleRules: "Always start with the hero's name, then a colon.",
        descriptionTemplate: "{hook}\n\nRecap of {title}.\n\n{summary}\n\nSubscribe to Night Shelf.",
        tags: ["night shelf", "manhwa recap"],
      },
      video: {
        fadeAtSceneBreaks: true,
        watermark: { assetId: logo.asset.id, corner: "top-left", opacity: 0.5, size: 0.1 },
        intro: { title: "Night Shelf", subtitle: "presents", durationMs: 2000 },
        output: { aspect: "9:16", height: 720 },
      },
    };
    await alice.post(
      "/api/channel-profiles",
      { name: "Bad", settings: { video: { ...settings.video, watermark: { assetId: bobLogo.asset.id } } } },
      400,
    );
    await alice.post("/api/channel-profiles", { name: "Bad", preset: "no-such-preset" }, 400);
    const r = await alice.post<{ profile: Profile }>(
      "/api/channel-profiles",
      { name: "Night Shelf", preset: "youtube-recap-30", settings },
      201,
    );
    profile = r.profile;
    const list = await alice.get<{ profiles: Profile[] }>("/api/channel-profiles");
    expect(list.profiles.map((p) => p.name)).toEqual(["Night Shelf"]);
    expect((await bob.get<{ profiles: Profile[] }>("/api/channel-profiles")).profiles).toEqual([]);
  });

  test("a project made from it gets the preset, settings, branding and a copy of the logo", async () => {
    const r = await alice.post<{ project: Project }>(
      "/api/projects",
      { title: "Ashes of the Tower", profileId: profile.id },
      201,
    );
    projectId = r.project.id;
    const { project } = await alice.get<{ project: Project }>(`/api/projects/${projectId}`);
    const s = project.settings;
    // The profile's preset made it a 16:9 film; the profile's own settings went on top of the preset's.
    expect(s.format).toBe("film");
    expect(project.projectType).toBe("manhwa");
    expect(s.imageQuality).toBe("medium");
    expect(s.targetRuntime?.minutes).toBe(45);
    expect([s.narrationVoice, s.narrationSpeed, s.referencePolicy, s.batchPolicy]).toEqual([
      "am_adam",
      1.2,
      "main",
      "images",
    ]);
    expect(s.thumbnailStyle?.side).toBe("right");
    expect(s.pronunciation).toMatchObject([{ term: "Qi", spoken: "chee" }]);
    expect(s.video?.intro?.title).toBe("Night Shelf");
    expect(s.video?.output).toEqual({ aspect: "9:16", height: 720 });
    expect(s.channelProfile).toMatchObject({ id: profile.id, name: "Night Shelf" });
    // The watermark is the project's own copy of the logo: same bytes, a different asset, owned by the project.
    const wm = s.video!.watermark!;
    expect(wm.corner).toBe("top-left");
    expect(wm.assetId).not.toBe(profile.settings.video!.watermark!.assetId);
    const copy = await assetRow(wm.assetId);
    const original = await assetRow(profile.settings.video!.watermark!.assetId);
    expect(copy?.project_id).toBe(projectId);
    expect(copy?.sha256).toBe(original!.sha256);
  });

  test("the YouTube rules reach the YouTube package prompt, and the channel's tags lead", async () => {
    const r = await alice.post<{ job: { id: string } }>(`/api/projects/${projectId}/youtube-package`, {}, 202);
    const job = await waitFor(
      async () => {
        const j = await alice.get<{ job: { status: string; compiledPrompt: string | null; templateVersion: number } }>(
          `/api/generations/${r.job.id}`,
        );
        return ["completed", "failed"].includes(j.job.status) ? j.job : null;
      },
      { label: "youtube package", timeoutMs: 60_000 },
    );
    expect(job.status).toBe("completed");
    expect(job.templateVersion).toBe(2);
    expect(job.compiledPrompt).toContain("<channel_rules>");
    expect(job.compiledPrompt).toContain("Always start with the hero's name");
    // {title} is filled by the app before the model sees the template.
    expect(job.compiledPrompt).toContain("Recap of Ashes of the Tower.");
    const { project } = await alice.get<{ project: Project }>(`/api/projects/${projectId}`);
    const pkg = project.settings.youtubePackage!;
    expect(pkg.tags.slice(0, 2)).toEqual(["night shelf", "manhwa recap"]);
    expect(pkg.description).toContain("Subscribe to Night Shelf.");
  });

  test("export defaults: a video without an aspect or height renders at the profile's output", async () => {
    const r = await alice.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { kind: "video_panels", acknowledgeIssues: true },
      202,
    );
    const [row] = await h.deps.db.execute<{ options: { video: { aspect: string; height: number } } }>(
      sql`select options from export_jobs where id = ${r.job.id}`,
    );
    expect(row!.options.video).toMatchObject({ aspect: "9:16", height: 720 });
    await alice.post(`/api/exports/${r.job.id}/cancel`).catch(() => {});
  });

  test("re-apply lists what would change first, and applies only on confirm", async () => {
    await alice.patch(`/api/projects/${projectId}`, {
      settings: { narrationVoice: "bf_emma", video: { fadeAtSceneBreaks: false } },
    });
    const preview = await alice.post<{ changes: Change[]; applied: boolean }>(
      `/api/projects/${projectId}/apply-profile`,
      { profileId: profile.id },
    );
    expect(preview.applied).toBe(false);
    expect(preview.changes.map((c) => c.key).sort()).toEqual([
      "narrationVoice",
      "video.fadeAtSceneBreaks",
      "video.intro",
      "video.output",
      "video.watermark",
    ]);
    expect(preview.changes.find((c) => c.key === "narrationVoice")).toEqual({
      key: "narrationVoice",
      from: "bf_emma",
      to: "am_adam",
    });
    // Nothing changed yet.
    const before = await alice.get<{ project: Project }>(`/api/projects/${projectId}`);
    expect(before.project.settings.narrationVoice).toBe("bf_emma");

    const done = await alice.post<{ changes: Change[]; applied: boolean }>(`/api/projects/${projectId}/apply-profile`, {
      profileId: profile.id,
      confirm: true,
    });
    expect(done.applied).toBe(true);
    const after = await alice.get<{ project: Project }>(`/api/projects/${projectId}`);
    expect(after.project.settings.narrationVoice).toBe("am_adam");
    expect(after.project.settings.video?.watermark).toMatchObject({ corner: "top-left" });
    // Re-applying an unchanged profile changes nothing: the logo is compared by its bytes, not copied again.
    const again = await alice.post<{ changes: Change[] }>(`/api/projects/${projectId}/apply-profile`, {
      profileId: profile.id,
    });
    expect(again.changes).toEqual([]);
  });

  test("save as profile: a project's channel settings become a new profile with its own logo", async () => {
    const r = await alice.post<{ profile: Profile }>(
      `/api/projects/${projectId}/channel-profile`,
      { name: "Copy of Night Shelf" },
      201,
    );
    const s = r.profile.settings;
    expect(s.narrationVoice).toBe("am_adam");
    expect(s.youtubeRules?.tags).toEqual(["night shelf", "manhwa recap"]);
    // Project outputs are not a channel's identity.
    expect(Object.keys(s)).not.toContain("youtubePackage");
    const logo = await assetRow(s.video!.watermark!.assetId);
    expect(logo?.project_id).toBeNull();
    // Deleting a profile removes its logo; projects keep their copies.
    await alice.del(`/api/channel-profiles/${r.profile.id}`);
    expect(await assetRow(s.video!.watermark!.assetId)).toBeUndefined();
    const { project } = await alice.get<{ project: Project }>(`/api/projects/${projectId}`);
    expect(await assetRow(project.settings.video!.watermark!.assetId)).toBeDefined();
  });

  test("a profile is its owner's alone", async () => {
    // Bob can't create a project from it, re-apply it, edit it or delete it: to him it does not exist.
    await bob.post("/api/projects", { title: "Stolen", profileId: profile.id }, 404);
    const own = await bob.post<{ project: Project }>("/api/projects", { title: "Bob's" }, 201);
    await bob.post(`/api/projects/${own.project.id}/apply-profile`, { profileId: profile.id }, 404);
    await bob.patch(`/api/channel-profiles/${profile.id}`, { name: "Mine now" }, 404);
    await bob.del(`/api/channel-profiles/${profile.id}`, 404);
    // Nor can he apply it to Alice's project, which he can't see either.
    await bob.post(`/api/projects/${projectId}/apply-profile`, { profileId: profile.id }, 404);
    // The profile's logo is served to its owner only.
    const logoId = profile.settings.video!.watermark!.assetId;
    expect((await alice.raw("GET", `/cdn/a/${logoId}`)).status).toBe(200);
    expect((await bob.raw("GET", `/cdn/a/${logoId}`)).status).toBe(404);
  });
});
