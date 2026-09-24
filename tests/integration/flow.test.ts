import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { FakeImageAIProvider } from "../../packages/ai-image/src/index.ts";
import { type startHarness as Start, startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: The Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword his father left him.
"Who's there?" Woo Jin asked, hearing footsteps behind him.
Kim Do-yun stepped out of the shadows near the stairwell. Kim Do-yun smiled coldly.
"You shouldn't be here," Kim Do-yun said. The door slammed shut with a BANG.
Woo Jin tightened his grip on the sword as the city lights flickered below.`;

type H = Awaited<ReturnType<typeof Start>>;
type Job = { id: string; status: string; failureReason?: string | null; failureCode?: string | null };

let h: H;
let alice: TestClient;
let bob: TestClient;

async function waitJob(c: TestClient, id: string, statuses = ["completed", "failed", "cancelled"]) {
  return waitFor(
    async () => {
      const r = await c.get<{ job: Job }>(`/api/generations/${id}`);
      return statuses.includes(r.job.status) ? r : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );
}

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

describe("auth", () => {
  test("register, login by username and email, logout, reset password", async () => {
    await alice.post(
      "/api/auth/register",
      { username: "alice", email: "alice@example.com", password: "correct horse 1" },
      201,
    );
    expect((await alice.get<{ user: { username: string } }>("/api/auth/me")).user.username).toBe("alice");
    await alice.post(
      "/api/auth/register",
      { username: "alice", email: "other@example.com", password: "correct horse 1" },
      409,
    );

    await alice.post("/api/auth/logout");
    expect((await alice.get<{ user: null }>("/api/auth/me")).user).toBeNull();
    await alice.post("/api/auth/login", { identifier: "alice", password: "wrong password" }, 401);
    await alice.post("/api/auth/login", { identifier: "ALICE@example.com", password: "correct horse 1" });
    expect((await alice.get<{ user: { email: string } }>("/api/auth/me")).user.email).toBe("alice@example.com");

    await bob.post(
      "/api/auth/register",
      { username: "bob", email: "bob@example.com", password: "bob password 1" },
      201,
    );

    // password reset through dev mailbox
    const anon = h.client();
    await anon.post("/api/auth/password-reset/request", { identifier: "bob" });
    await anon.post("/api/auth/password-reset/request", { identifier: "nobody" }); // no enumeration
    // The mailbox route is admin-only (it hands out live reset links), so read the stored mail directly here.
    await anon.get("/api/dev/mailbox", 401);
    const mails = await h.deps.db.execute<{ to: string; metadata: { resetUrl: string } }>(
      sql`select "to", metadata from dev_emails order by created_at desc limit 10`,
    );
    const email = [...mails].find((e) => e.to === "bob@example.com")!;
    const token = new URL(email.metadata.resetUrl).searchParams.get("token")!;
    await anon.post("/api/auth/password-reset/confirm", { token, password: "bob new password" });
    await anon.post("/api/auth/password-reset/confirm", { token, password: "bob other password" }, 400); // one-time
    expect((await bob.get<{ user: null }>("/api/auth/me")).user).toBeNull(); // sessions revoked
    await bob.post("/api/auth/login", { identifier: "bob@example.com", password: "bob new password" });
  });

  test("csrf is enforced", async () => {
    const res = await h.app.request("http://test.local/api/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: [...alice.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
  });

  test("unauthenticated API access is rejected", async () => {
    expect((await h.client().raw("GET", "/api/projects")).status).toBe(401);
  });
});

describe("full production flow (mock AI)", () => {
  let projectId = "";
  let chapterId = "";
  let characterId = "";
  let versionId = "";
  let pageId = "";
  let panelId = "";
  let artworkAssetId = "";

  test("the account default narration voice seeds new projects", async () => {
    const before = await alice.get<{ user: { settings: { narrationVoice?: string } } }>("/api/auth/me");
    expect(before.user.settings.narrationVoice).toBeUndefined();

    await alice.patch("/api/auth/settings", { narrationVoice: "am_adam" });
    const me = await alice.get<{ user: { settings: { narrationVoice?: string } } }>("/api/auth/me");
    expect(me.user.settings.narrationVoice).toBe("am_adam");

    const made = await alice.post<{ project: { id: string; settings: { narrationVoice: string } } }>(
      "/api/projects",
      { title: "Voice default", projectType: "manhwa" },
      201,
    );
    expect(made.project.settings.narrationVoice).toBe("am_adam");

    // Changing the preference never reaches a project that already exists: each keeps its own copy.
    await alice.patch("/api/auth/settings", { narrationVoice: "bf_emma" });
    const unchanged = await alice.get<{ project: { settings: { narrationVoice: string } } }>(
      `/api/projects/${made.project.id}`,
    );
    expect(unchanged.project.settings.narrationVoice).toBe("am_adam");

    // An empty value clears it, so new projects fall back to the server default again.
    await alice.patch("/api/auth/settings", { narrationVoice: "" });
    const cleared = await alice.get<{ user: { settings: { narrationVoice?: string } } }>("/api/auth/me");
    expect(cleared.user.settings.narrationVoice).toBeUndefined();
  });

  test("create project with story", async () => {
    const r = await alice.post<{ project: { id: string; readingDirection: string } }>(
      "/api/projects",
      { title: "Rain City", projectType: "manhwa", story: { content: STORY, inputKind: "story" } },
      201,
    );
    projectId = r.project.id;
    const list = await alice.get<{ projects: { id: string }[] }>("/api/projects");
    expect(list.projects.map((p) => p.id)).toContain(projectId);
    // bob cannot see it
    await bob.get(`/api/projects/${projectId}`, 404);
  });

  test("story analysis -> review -> apply", async () => {
    const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
    const r = await alice.post<{ job: Job; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    const done = await waitJob(alice, r.job.id);
    expect(done.job.status).toBe("completed");
    expect((done as unknown as { usage: unknown[] }).usage.length).toBeGreaterThan(0);
    const a = await alice.get<{ analysis: { status: string; result: { characters: { name: string }[] } } }>(
      `/api/story-analyses/${r.analysis.id}`,
    );
    expect(a.analysis.status).toBe("completed");
    const names = a.analysis.result.characters.map((c) => c.name);
    expect(names).toContain("Woo Jin");
    const applied = await alice.post<{ created: { characters: number; chapters: number } }>(
      `/api/story-analyses/${r.analysis.id}/apply`,
      {},
    );
    expect(applied.created.characters).toBeGreaterThanOrEqual(2);
    expect(applied.created.chapters).toBe(1);

    // locked revision forks on edit instead of being overwritten
    const saved = await alice.patch<{ forked: boolean; revision: { revisionNumber: number } }>(
      `/api/story-revisions/${story.latest.id}`,
      { content: `${STORY}\nAn extra line.` },
    );
    expect(saved.forked).toBe(true);
    expect(saved.revision.revisionNumber).toBe(2);
  });

  test("an earlier style version can be made current again", async () => {
    type Styles = { currentStyleId: string; versions: { id: string; versionNumber: number; status: string }[] };
    const first = await alice.get<Styles>(`/api/projects/${projectId}/style`);
    const original = first.currentStyleId;
    expect(original).toBeTruthy();
    // Applying a style always mints a new version, which is why going back used to mean retyping the old one.
    await alice.post(`/api/projects/${projectId}/style`, { stylePresetKey: null, customDescription: "moodier" }, 201);
    const after = await alice.get<Styles>(`/api/projects/${projectId}/style`);
    expect(after.currentStyleId).not.toBe(original);
    expect(after.versions.find((v) => v.id === original)!.status).toBe("superseded");

    await alice.post(`/api/project-styles/${original}/make-current`);
    const back = await alice.get<Styles>(`/api/projects/${projectId}/style`);
    expect(back.currentStyleId).toBe(original);
    expect(back.versions.find((v) => v.id === original)!.status).toBe("approved");
    // The version it replaced is stood down rather than deleted, so this is reversible both ways.
    expect(back.versions.find((v) => v.id === after.currentStyleId)!.status).toBe("superseded");
    // Restore what the rest of the suite expects.
    await alice.post(`/api/project-styles/${after.currentStyleId}/make-current`);
  });

  test("cast: edit, generate full-res reference, approve -> small derivative", async () => {
    const cast = await alice.get<{ characters: { id: string; name: string; currentVersionId: string }[] }>(
      `/api/projects/${projectId}/characters`,
    );
    const woo = cast.characters.find((c) => c.name === "Woo Jin")!;
    characterId = woo.id;
    versionId = woo.currentVersionId;
    const detail = await alice.get<{ versions: { id: string; description: Record<string, unknown> }[] }>(
      `/api/characters/${characterId}`,
    );
    const desc = { ...detail.versions[0]!.description, hair: "short black undercut with a single silver streak" };
    await alice.patch(`/api/character-versions/${versionId}`, { description: desc });

    const g = await alice.post<{ job: Job }>(
      `/api/character-versions/${versionId}/references/generate`,
      { kind: "portrait" },
      202,
    );
    const done = await waitJob(alice, g.job.id);
    expect(done.job.status).toBe("completed");
    const refs = await alice.get<{
      references: { id: string; asset: { id: string; width: number; height: number } }[];
    }>(`/api/characters/${characterId}`);
    const ref = refs.references[0]!;
    expect(ref.asset.width).toBeGreaterThanOrEqual(1024); // full resolution canonical
    const approved = await alice.post<{ derivative: { width: number; height: number } }>(
      `/api/references/${ref.id}/status`,
      { status: "approved" },
    );
    expect(approved.derivative.height).toBeLessThanOrEqual(288);
    expect(approved.derivative.width).toBeLessThanOrEqual(192);
    await alice.post(`/api/character-versions/${versionId}/status`, { status: "approved" });
    // approved versions are immutable
    await alice.patch(`/api/character-versions/${versionId}`, { description: desc }, 409);

    // also approve Kim Do-yun with an uploaded reference
    const kim = cast.characters.find((c) => c.name === "Kim Do-yun")!;
    const png = await sharp({ create: { width: 900, height: 1300, channels: 3, background: "#884422" } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png)], "kim.png", { type: "image/png" }));
    form.set("kind", "portrait");
    const up = await alice.json<{ reference: { id: string } }>(
      "POST",
      `/api/character-versions/${kim.currentVersionId}/references/upload`,
      form,
      201,
    );
    await alice.post(`/api/references/${up.reference.id}/status`, { status: "approved" });
    // fake type upload rejected
    const bad = new FormData();
    bad.set("file", new File(["<svg/>"], "x.png", { type: "image/png" }));
    await alice.json("POST", `/api/character-versions/${kim.currentVersionId}/references/upload`, bad, 415);
  });

  test("chapter planning creates scenes/pages/panels with specs and lettering", async () => {
    const chs = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    chapterId = chs.chapters[0]!.id;
    const r = await alice.post<{ job: Job }>(`/api/chapters/${chapterId}/plan`, {}, 202);
    const done = await waitJob(alice, r.job.id);
    expect(done.job.status).toBe("completed");
    const ch = await alice.get<{ scenes: unknown[]; pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
    expect(ch.scenes.length).toBeGreaterThan(0);
    expect(ch.pages.length).toBeGreaterThanOrEqual(2);
    pageId = ch.pages[0]!.id;
    const page = await alice.get<{
      panels: { id: string; spec: unknown; characterVersionIds: string[] }[];
      dialogue: unknown[];
    }>(`/api/pages/${pageId}`);
    expect(page.panels.length).toBeGreaterThanOrEqual(3);
    expect(page.panels[0]!.spec).toBeTruthy();
    // lettering auto-placement is off by default: clean pages
    for (const pg of ch.pages) {
      const d = await alice.get<{ dialogue: unknown[]; sfx: unknown[] }>(`/api/pages/${pg.id}`);
      expect(d.dialogue).toHaveLength(0);
      expect(d.sfx).toHaveLength(0);
    }
    panelId = page.panels.find((p) => p.characterVersionIds.includes(versionId))?.id ?? page.panels[0]!.id;
    await alice.patch(`/api/panels/${panelId}`, { characterVersionIds: [versionId] });
    // replanning without replace is refused
    await alice.post(`/api/chapters/${chapterId}/plan`, {}, 409);
  });

  test("layout swap, add/duplicate/split/reorder panels", async () => {
    await alice.post(`/api/pages/${pageId}/layout`, { layoutTemplate: "four-grid" });
    let page = await alice.get<{ panels: { id: string; frame: { x: number } }[] }>(`/api/pages/${pageId}`);
    expect(page.panels.length).toBeGreaterThanOrEqual(4);
    const dup = await alice.post<{ panel: { id: string } }>(
      `/api/pages/${pageId}/panels`,
      { duplicateOf: panelId },
      201,
    );
    const split = await alice.post<{ panel: { id: string } }>(
      `/api/panels/${dup.panel.id}/split`,
      { direction: "vertical" },
      201,
    );
    page = await alice.get(`/api/pages/${pageId}`);
    const ids = page.panels.map((p) => p.id).reverse();
    await alice.post(`/api/pages/${pageId}/reorder-panels`, { panelIds: ids });
    await alice.patch(`/api/pages/${pageId}/document`, {
      panels: [{ id: split.panel.id, frame: { x: 0.1, y: 0.1, width: 0.3, height: 0.2 } }],
    });
    await alice.del(`/api/panels/${split.panel.id}`);
    await alice.del(`/api/panels/${dup.panel.id}`);
  });

  test("prompt inspector shows small derivatives, generation uses them", async () => {
    const preview = await alice.get<{ compiledPrompt: string; references: { role: string }[] }>(
      `/api/panels/${panelId}/prompt-preview`,
    );
    expect(preview.compiledPrompt).toContain("STRICT EXCLUSIONS");
    expect(preview.compiledPrompt).not.toContain("DIALOGUE NEGATIVE SPACE");
    expect(preview.compiledPrompt).toContain("Woo Jin is the person shown in reference image 1");
    const r = await alice.post<{ job: Job }>(`/api/panels/${panelId}/generate`, {}, 202);
    const done = await waitJob(alice, r.job.id);
    expect(done.job.status).toBe("completed");
    const detail = done as unknown as {
      inputs: { role: string; sentAs: string; width: number; height: number; metadata: { canonicalWidth: number } }[];
      outputs: { assetId: string; activated: boolean }[];
      usage: { imageInputTokens: number }[];
      job: { compiledPrompt: string; model: string; templateName: string };
    };
    const charRef = detail.inputs.find((i) => i.role === "character_ref")!;
    expect(charRef.sentAs).toBe("prompt_ref_derivative");
    expect(charRef.width).toBeLessThanOrEqual(192);
    expect(charRef.height).toBeLessThanOrEqual(288);
    expect(charRef.metadata.canonicalWidth).toBeGreaterThanOrEqual(1024);
    expect(detail.outputs[0]!.activated).toBe(true);
    expect(detail.job.templateName).toBe("panel-generation");
    artworkAssetId = detail.outputs[0]!.assetId;
    const page = await alice.get<{ panels: { id: string; activeArtworkAssetId: string; status: string }[] }>(
      `/api/pages/${pageId}`,
    );
    expect(page.panels.find((p) => p.id === panelId)!.activeArtworkAssetId).toBe(artworkAssetId);
  });

  test("a prop attached to a panel reaches the compiled prompt", async () => {
    // The API and the prompt always supported props; nothing in the editor could attach one, so this path only
    // ever ran through AI planning.
    const created = await alice.post<{ prop: { id: string; currentVersionId: string } }>(
      `/api/projects/${projectId}/props`,
      { name: "Brass Compass", description: { summary: "a dented brass compass with a cracked glass face" } },
      201,
    );
    await alice.patch(`/api/panels/${panelId}`, { propVersionIds: [created.prop.currentVersionId] });
    const preview = await alice.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`);
    expect(preview.compiledPrompt).toContain("Brass Compass");
    // Detaching removes it again.
    await alice.patch(`/api/panels/${panelId}`, { propVersionIds: [] });
    const after = await alice.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`);
    expect(after.compiledPrompt).not.toContain("Brass Compass");
  });

  test("regenerate with edited prompt creates a new version; activate/revert", async () => {
    const r = await alice.post<{ job: Job }>(
      `/api/panels/${panelId}/generate`,
      { operation: "change_expression", instruction: "make him look furious" },
      202,
    );
    const done = await waitJob(alice, r.job.id);
    expect((done.job as unknown as { compiledPrompt: string }).compiledPrompt).toContain("REVISION REQUEST");
    const v = await alice.get<{ activeAssetId: string; versions: { assetId: string }[] }>(
      `/api/panels/${panelId}/versions`,
    );
    expect(v.versions.length).toBe(2);
    expect(v.activeAssetId).not.toBe(artworkAssetId);
    await alice.post(`/api/panels/${panelId}/versions/${artworkAssetId}/activate`);
    const v2 = await alice.get<{ activeAssetId: string }>(`/api/panels/${panelId}/versions`);
    expect(v2.activeAssetId).toBe(artworkAssetId);
  });

  test("masked edit: full-res target and mask, small refs", async () => {
    const art = await alice.raw("GET", `/cdn/a/${artworkAssetId}`);
    expect(art.status).toBe(200);
    const meta = await sharp(Buffer.from(await art.arrayBuffer())).metadata();
    const mask = await sharp({
      create: { width: meta.width!, height: meta.height!, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite([
        {
          input: await sharp({ create: { width: 200, height: 200, channels: 4, background: "#ffffff" } })
            .png()
            .toBuffer(),
          left: 10,
          top: 10,
        },
      ])
      .png()
      .toBuffer();
    const form = new FormData();
    form.set("file", new File([new Uint8Array(mask)], "mask.png", { type: "image/png" }));
    const m = await alice.json<{ asset: { id: string } }>("POST", `/api/panels/${panelId}/mask`, form, 201);
    const r = await alice.post<{ job: Job }>(
      `/api/panels/${panelId}/edit`,
      { maskAssetId: m.asset.id, instruction: "remove the umbrella" },
      202,
    );
    const done = (await waitJob(alice, r.job.id)) as unknown as {
      job: Job;
      inputs: { role: string; sentAs: string; width: number }[];
    };
    expect(done.job.status).toBe("completed");
    const target = done.inputs.find((i) => i.role === "target")!;
    expect(target.sentAs).toBe("full_resolution");
    expect(target.width).toBe(meta.width!);
    expect(done.inputs.find((i) => i.role === "mask")!.sentAs).toBe("full_resolution");
    const refs = done.inputs.filter((i) => i.role === "character_ref");
    for (const ref of refs) expect(ref.sentAs).toBe("prompt_ref_derivative");
    const imageCalls = (
      h.workerDeps.image as unknown as { calls: { endpoint: string; targetBytes?: number; maskBytes?: number }[] }
    ).calls;
    expect(imageCalls.at(-1)!.maskBytes).toBeGreaterThan(0);
  });

  test("dialogue, SFX and narration boxes cost zero image calls", async () => {
    const before = (h.workerDeps.image as unknown as { calls: unknown[] }).calls.length;
    const d = await alice.post<{ dialogue: { id: string; bubble: { x: number } } }>(
      `/api/pages/${pageId}/dialogue`,
      { panelId, text: "Who's there?" },
      201,
    );
    await alice.patch(`/api/dialogue/${d.dialogue.id}`, {
      text: "Show yourself!",
      bubble: { ...d.dialogue.bubble, type: "shout", x: 0.2 },
    });
    const s = await alice.post<{ sfx: { id: string } }>(`/api/pages/${pageId}/sfx`, { panelId, text: "CRASH" }, 201);
    await alice.patch(`/api/pages/${pageId}/document`, { sfx: [{ id: s.sfx.id, text: "BAM" }] });
    expect((h.workerDeps.image as unknown as { calls: unknown[] }).calls.length).toBe(before);
    const preview = await alice.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`);
    expect(preview.compiledPrompt).toContain("DIALOGUE NEGATIVE SPACE");
  });

  test("project lettering defaults drive new text and can be re-applied", async () => {
    await alice.patch(`/api/projects/${projectId}`, {
      settings: { lettering: { types: { normal: { fontSize: 20, background: "#abcdef" } }, sfx: { fontSize: 50 } } },
    });
    const d = await alice.post<{ dialogue: { id: string; bubble: { fontSize: number; width: number } } }>(
      `/api/pages/${pageId}/dialogue`,
      { panelId, text: "Hi" },
      201,
    );
    expect(d.dialogue.bubble.fontSize).toBe(20);
    expect(d.dialogue.bubble.width).toBeLessThan(0.2);
    const s = await alice.post<{ sfx: { style: { fontSize: number } } }>(
      `/api/pages/${pageId}/sfx`,
      { panelId, text: "ZAP" },
      201,
    );
    expect(s.sfx.style.fontSize).toBe(50);
    await alice.patch(`/api/dialogue/${d.dialogue.id}`, {
      bubble: { ...d.dialogue.bubble, fontSize: 60, width: 0.9, background: "#000000" },
    });
    const r = await alice.post<{ bubbles: number; sfx: number }>(`/api/pages/${pageId}/lettering/apply-defaults`, {
      scope: "page",
      types: ["normal", "sfx"],
    });
    expect(r.bubbles).toBeGreaterThan(0);
    expect(r.sfx).toBeGreaterThan(0);
    const doc = await alice.get<{
      dialogue: { id: string; bubble: { fontSize: number; width: number; background: string } }[];
    }>(`/api/pages/${pageId}`);
    const b = doc.dialogue.find((x) => x.id === d.dialogue.id)!.bubble;
    expect(b).toMatchObject({ fontSize: 20, background: "#abcdef" });
    expect(b.width).toBeLessThan(0.2);
    await alice.patch(`/api/projects/${projectId}`, { settings: { lettering: {} } });
  });

  test("remove lettering clears bubbles and SFX, keeps narration lines", async () => {
    const before = await alice.get<{ dialogue: unknown[]; sfx: unknown[] }>(`/api/pages/${pageId}`);
    expect(before.dialogue.length + before.sfx.length).toBeGreaterThan(0);
    await bob.post(`/api/pages/${pageId}/lettering/clear`, { scope: "page" }, 404);
    const r = await alice.post<{ bubbles: number; sfx: number; pages: number }>(
      `/api/pages/${pageId}/lettering/clear`,
      {
        scope: "chapter",
      },
    );
    expect(r.bubbles).toBe(before.dialogue.length);
    expect(r.sfx).toBe(before.sfx.length);
    const after = await alice.get<{ dialogue: unknown[]; sfx: unknown[] }>(`/api/pages/${pageId}`);
    expect(after.dialogue).toHaveLength(0);
    expect(after.sfx).toHaveLength(0);
  });

  test("bulk page generation with confirmation and progress", async () => {
    const est = await alice.post<{ confirmRequired: boolean; count: number }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: true },
    );
    expect(est.confirmRequired).toBe(true);
    expect(est.count).toBeGreaterThan(0);
    const r = await alice.post<{ batchId: string; jobs: unknown[] }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: true, confirm: true },
      202,
    );
    await waitFor(
      async () => {
        const p = await alice.get<{ progress: { total: number; completed: number; failed: number } }>(
          `/api/generations/batches/${r.batchId}`,
        );
        return p.progress.completed + p.progress.failed === p.progress.total ? p : null;
      },
      { timeoutMs: 90_000, label: "batch" },
    );
    const b = await alice.get<{
      batches: { batchId: string; state: string; chapters: { id: string }[]; progress: { total: number } }[];
    }>(`/api/projects/${projectId}/generations/batches`);
    const mine = b.batches.find((x) => x.batchId === r.batchId)!;
    expect(mine.state).toBe("finished");
    expect(mine.chapters.map((c) => c.id)).toContain(chapterId);
    const again = await alice.post<{ count: number; skippedReasons: { hasArtwork: number } }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: true },
    );
    expect(again.count).toBe(0);
    expect(again.skippedReasons.hasArtwork).toBeGreaterThan(0);
  }, 120_000);

  test("narration: DeepSeek text -> local TTS -> timeline", async () => {
    const g = await alice.post<{ job: Job }>(
      `/api/chapters/${chapterId}/narration/generate`,
      { style: "dramatic recap" },
      202,
    );
    const narrationJob = await waitJob(alice, g.job.id);
    expect(narrationJob.job.status).toBe("completed");
    // It knows who is in the chapter (for names and pronouns) and the world it is set in.
    const asked = (narrationJob.job as { compiledPrompt?: string }).compiledPrompt ?? "";
    expect(asked).toContain('"name":"Woo Jin","role":"protagonist","aliases":["he","the boy"],"genderPresentation"');
    expect(asked).toContain('"worldNotes":"Setting: Rooftop');
    const n = await alice.get<{ lines: { id: string; segments: { id: string }[] }[] }>(
      `/api/chapters/${chapterId}/narration`,
    );
    expect(n.lines.length).toBeGreaterThan(0);
    // v2: every panel gets narration at roughly the words-per-panel target
    const detail = await alice.get<{
      lines: { panelId: string | null; text: string }[];
    }>(`/api/chapters/${chapterId}/narration`);
    const ch = await alice.get<{ pages: { panelCount: number }[] }>(`/api/chapters/${chapterId}`);
    const panelTotal = ch.pages.reduce((s, p) => s + p.panelCount, 0);
    const narrated = new Set(detail.lines.map((l) => l.panelId).filter(Boolean)).size;
    expect(narrated / panelTotal).toBeGreaterThanOrEqual(0.9);
    const words = detail.lines.filter((l) => l.panelId).reduce((s, l) => s + l.text.split(/\s+/).length, 0);
    expect(words / narrated).toBeGreaterThanOrEqual(15);
    expect(words / narrated).toBeLessThanOrEqual(30);
    const list = await alice.get<{ chapters: { id: string; stats: { narratedPanels: number; panels: number } }[] }>(
      `/api/projects/${projectId}/chapters`,
    );
    expect(list.chapters.find((c) => c.id === chapterId)!.stats.narratedPanels).toBe(narrated);
    const synth = await alice.post<{ queued: number }>(
      `/api/chapters/${chapterId}/narration/synthesize`,
      { onlyMissing: true },
      202,
    );
    expect(synth.queued).toBeGreaterThan(0);
    await waitFor(
      async () => {
        const r = await alice.get<{ lines: { segments: { audio: unknown; job: { status: string } | null }[] }[] }>(
          `/api/chapters/${chapterId}/narration`,
        );
        return r.lines.every((l) => l.segments.every((s) => s.audio)) ? r : null;
      },
      { label: "tts" },
    );
    // Project-wide synthesis progress: the editor shows one chapter, this is how a run across several is watched.
    const prog = await alice.get<{
      language: string;
      chapters: { id: string; segments: number; withAudio: number; queued: number; processing: number }[];
      totals: { chapters: number; segments: number; withAudio: number; queued: number; processing: number };
    }>(`/api/projects/${projectId}/narration/progress`);
    const mine = prog.chapters.find((ch) => ch.id === chapterId)!;
    expect(mine.segments).toBeGreaterThan(0);
    // Everything finished above, so every segment has audio and nothing is left running.
    expect(mine.withAudio).toBe(mine.segments);
    expect(prog.totals.withAudio).toBe(prog.totals.segments);
    expect(prog.totals.queued + prog.totals.processing).toBe(0);
    // Chapters with no narration in this language are left out rather than listed as 0/0.
    expect(prog.chapters.every((ch) => ch.segments > 0)).toBe(true);

    const tl = await alice.get<{ segments: { startMs: number; durationMs: number }[]; totalDurationMs: number }>(
      `/api/chapters/${chapterId}/narration/timeline`,
    );
    expect(tl.totalDurationMs).toBeGreaterThan(0);
    expect(tl.segments[1]?.startMs ?? 1).toBeGreaterThan(0);
    // re-synthesizing unchanged text reuses cached audio
    const seg = n.lines[0]!.segments[0]!;
    const again = await alice.post<{ job: { id: string } }>(`/api/narration-segments/${seg.id}/synthesize`, {}, 202);
    await waitFor(
      async () => {
        const [row] = await h.deps.db.execute<{ status: string; reused_cache: boolean }>(
          `select status, reused_cache from audio_jobs where id = '${again.job.id}'` as never,
        );
        return row?.status === "completed" ? row : null;
      },
      { label: "cached tts" },
    );
  });

  test("video preview: same shot plan as the render, per chapter/page/panel, lettered page PNG", async () => {
    type Shot = {
      key: string;
      page: { id: string };
      panel: { id: string; art: { crop: { width: number }; focus: { x: number } } | null } | null;
      segments: { audioAssetId: string | null; durationMs: number | null }[];
    };
    const chapterPanel = await alice.get<{ cut: string; shots: Shot[] }>(`/api/video-preview?chapterId=${chapterId}`);
    const ch = await alice.get<{ pages: { panelCount: number }[] }>(`/api/chapters/${chapterId}`);
    expect(chapterPanel.cut).toBe("panel");
    expect(chapterPanel.shots.length).toBe(ch.pages.reduce((n, p) => n + p.panelCount, 0));
    const withArt = chapterPanel.shots.find((x) => x.panel?.art)!;
    expect(withArt.panel!.art!.crop.width).toBeGreaterThan(0);
    expect(withArt.panel!.art!.focus.x).toBeGreaterThanOrEqual(0);
    const voiced = chapterPanel.shots.flatMap((x) => x.segments).filter((x) => x.audioAssetId);
    expect(voiced.length).toBeGreaterThan(0);
    expect(voiced.every((x) => (x.durationMs ?? 0) > 0)).toBe(true);

    const pageCut = await alice.get<{ shots: Shot[] }>(`/api/video-preview?chapterId=${chapterId}&cut=page`);
    expect(pageCut.shots.length).toBe(ch.pages.length);
    // every narration segment lands somewhere in both cuts
    const count = (r: { shots: Shot[] }) => r.shots.reduce((n, x) => n + x.segments.length, 0);
    expect(count(pageCut)).toBe(count(chapterPanel));

    const single = await alice.get<{ cut: string; shots: Shot[] }>(`/api/video-preview?panelId=${panelId}&cut=page`);
    expect(single.cut).toBe("panel");
    expect(single.shots.map((x) => x.panel?.id)).toEqual([panelId]);
    const onePage = await alice.get<{ shots: Shot[] }>(`/api/video-preview?pageId=${pageId}`);
    expect(onePage.shots.every((x) => x.page.id === pageId)).toBe(true);

    const png = await alice.raw("GET", `/api/pages/${pageId}/render.png?width=400`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
    const meta = await sharp(new Uint8Array(await png.arrayBuffer())).metadata();
    expect(meta.width).toBe(400);

    await alice.get(`/api/video-preview?chapterId=${chapterId}&pageId=${pageId}`, 400);
    expect((await bob.raw("GET", `/api/video-preview?chapterId=${chapterId}`)).status).toBeGreaterThanOrEqual(403);
    expect((await bob.raw("GET", `/api/pages/${pageId}/render.png`)).status).toBeGreaterThanOrEqual(403);
  });

  test("exports: page PNG, webtoon, PDF, narration, project JSON, package", async () => {
    for (const kind of [
      "png_pages",
      "webtoon",
      "pdf",
      "narration_audio",
      "project_json",
      "zip_package",
      "agent_package",
    ]) {
      const r = await alice.post<{ job: { id: string } }>(
        `/api/projects/${projectId}/exports`,
        {
          kind,
          chapterId: kind === "project_json" || kind === "zip_package" || kind === "agent_package" ? null : chapterId,
          audio: { format: "wav", normalize: false },
        },
        202,
      );
      const done = await waitFor(
        async () => {
          const l = await alice.get<{
            jobs: {
              id: string;
              status: string;
              failureReason: string | null;
              files: { assetId: string; fileName: string; mimeType: string }[];
            }[];
          }>(`/api/projects/${projectId}/exports`);
          const j = l.jobs.find((x) => x.id === r.job.id);
          return j && ["completed", "failed"].includes(j.status) ? j : null;
        },
        { timeoutMs: 90_000, label: `export ${kind}` },
      );
      expect(`${kind}:${done.status}:${done.failureReason ?? ""}`).toBe(`${kind}:completed:`);
      const f = done.files[0]!;
      const res = await alice.raw("GET", `/cdn/a/${f.assetId}`);
      expect(res.status).toBe(200);
      const buf = new Uint8Array(await res.arrayBuffer());
      if (kind === "agent_package") {
        expect(new TextDecoder().decode(buf.slice(0, 2))).toBe("PK");
        const names = new TextDecoder("latin1").decode(buf);
        for (const f of ["manifest.json", "README.md", "narration/timeline.json", ".lettered.png", "characters/"])
          expect(names).toContain(f);
      }
      if (kind === "pdf") expect(new TextDecoder().decode(buf.slice(0, 5))).toBe("%PDF-");
      if (kind === "project_json") expect(JSON.parse(new TextDecoder().decode(buf)).schemaVersion).toBe(1);
    }
  }, 240_000);

  test("readiness gate, narration languages, audio cancel and consistency check", async () => {
    // an empty panel makes the chapter "not ready" for image exports
    const added = await alice.post<{ panel: { id: string } }>(`/api/pages/${pageId}/panels`, {}, 201);
    const r1 = await alice.get<{ issues: { code: string; severity: string; chapterId: string }[] }>(
      `/api/projects/${projectId}/readiness?chapterId=${chapterId}`,
    );
    expect(r1.issues.some((i) => i.code === "missing_artwork" && i.severity === "block")).toBe(true);
    const gated = await alice.raw("POST", `/api/projects/${projectId}/exports`, { kind: "png_pages", chapterId });
    expect(gated.status).toBe(409);
    const gatedBody = (await gated.json()) as { error: { code: string; details: { issues: { code: string }[] } } };
    expect(gatedBody.error.code).toBe("export_not_ready");
    expect(gatedBody.error.details.issues.map((i) => i.code)).toContain("missing_artwork");
    await alice.post(
      `/api/projects/${projectId}/exports`,
      { kind: "png_pages", chapterId, acknowledgeIssues: true },
      202,
    );
    // project_json has no readiness requirements
    await alice.post(`/api/projects/${projectId}/exports`, { kind: "project_json" }, 202);
    await alice.del(`/api/panels/${added.panel.id}`);

    // a second narration language is its own track
    await alice.post(
      `/api/chapters/${chapterId}/narration/lines`,
      { text: "Hola desde la azotea.", language: "es" },
      201,
    );
    const es = await alice.get<{ language: string; lines: { text: string }[]; tracks: { language: string }[] }>(
      `/api/chapters/${chapterId}/narration?language=es`,
    );
    expect(es.language).toBe("es");
    expect(es.lines.map((l) => l.text)).toContain("Hola desde la azotea.");
    expect(es.tracks.map((t) => t.language).sort()).toEqual(["en", "es"]);
    const en = await alice.get<{ lines: { text: string }[] }>(`/api/chapters/${chapterId}/narration`);
    expect(en.lines.map((l) => l.text)).not.toContain("Hola desde la azotea.");
    const gen = await alice.post<{ job: Job }>(
      `/api/chapters/${chapterId}/narration/generate`,
      { language: "es", replace: true },
      202,
    );
    const genDone = await waitJob(alice, gen.job.id);
    expect(genDone.job.status).toBe("completed");
    const es2 = await alice.get<{ lines: { language: string }[] }>(`/api/chapters/${chapterId}/narration?language=es`);
    expect(es2.lines.length).toBeGreaterThan(1);
    const esReady = await alice.get<{ language: string; issues: { code: string }[] }>(
      `/api/projects/${projectId}/readiness?chapterId=${chapterId}&language=es`,
    );
    expect(esReady.language).toBe("es");
    expect(esReady.issues.map((i) => i.code)).toContain("missing_audio");

    // queued synthesis can be cancelled
    const synth = await alice.post<{ queued: number }>(
      `/api/chapters/${chapterId}/narration/synthesize`,
      { language: "es", onlyMissing: true },
      202,
    );
    expect(synth.queued).toBeGreaterThan(0);
    const cancel = await alice.post<{ cancelled: number; remaining: number }>(
      `/api/chapters/${chapterId}/narration/synthesize/cancel`,
    );
    expect(cancel.cancelled + cancel.remaining).toBeGreaterThanOrEqual(0);
    await bob.post(`/api/chapters/${chapterId}/narration/synthesize/cancel`, {}, 404);

    // consistency check: manual run stores a verdict; enabling it queues a check after each generation
    const chk = await alice.post<{ job: Job }>(`/api/panels/${panelId}/check`, {}, 202);
    expect((await waitJob(alice, chk.job.id)).job.status).toBe("completed");
    const doc = await alice.get<{ panels: { id: string; qa: { verdict: string; expected: string[] } | null }[] }>(
      `/api/pages/${pageId}`,
    );
    const qa = doc.panels.find((p) => p.id === panelId)!.qa!;
    expect(qa.verdict).toBe("ok");
    await alice.patch(`/api/projects/${projectId}`, {
      settings: { consistencyCheck: { enabled: true, credentialId: null, model: "" } },
    });
    const g = await alice.post<{ job: Job }>(`/api/panels/${panelId}/generate`, {}, 202);
    await waitJob(alice, g.job.id);
    const checks = await waitFor(
      async () => {
        const l = await alice.get<{ jobs: { kind: string; targetId: string; status: string }[] }>(
          `/api/projects/${projectId}/generations?kind=panel_check`,
        );
        const mine = l.jobs.filter((j) => j.kind === "panel_check" && j.targetId === panelId);
        return mine.length >= 2 && mine.every((j) => j.status === "completed") ? mine : null;
      },
      { label: "auto panel check", timeoutMs: 60_000 },
    );
    expect(checks.length).toBeGreaterThanOrEqual(2);
    await alice.patch(`/api/projects/${projectId}`, { settings: { consistencyCheck: { enabled: false } } });

    // outfit reference: a panel whose spec names a known outfit sends that outfit's approved reference too
    const outfit = await alice.post<{ outfit: { id: string } }>(
      `/api/characters/${characterId}/outfits`,
      { name: "Rain Coat", description: "long yellow raincoat" },
      201,
    );
    const og = await alice.post<{ job: Job }>(
      `/api/character-versions/${versionId}/references/generate`,
      { kind: "outfit", outfitId: outfit.outfit.id },
      202,
    );
    expect((await waitJob(alice, og.job.id)).job.status).toBe("completed");
    // the approved design is what the prompt tells the model to reproduce, so it must actually be sent
    const [ogUsage] = await h.deps.db.execute<{ n: number }>(
      sql`select (metadata->>'referenceCount')::int as n from ai_usage where generation_job_id = ${og.job.id}`,
    );
    expect(ogUsage?.n).toBe(1);
    const detail = await alice.get<{ references: { id: string; kind: string; outfitId: string | null }[] }>(
      `/api/characters/${characterId}`,
    );
    const outfitRef = detail.references.find((r) => r.outfitId === outfit.outfit.id)!;
    await alice.post(`/api/references/${outfitRef.id}/status`, { status: "approved" });
    const pd = await alice.get<{
      panels: { id: string; spec: Record<string, unknown> & { characters: Record<string, unknown>[] } }[];
    }>(`/api/pages/${pageId}`);
    const spec = pd.panels.find((p) => p.id === panelId)!.spec;
    const cid = spec.characters[0]?.characterId ?? characterId;
    await alice.put(`/api/panels/${panelId}/spec`, {
      spec: {
        ...spec,
        characters: [{ ...(spec.characters[0] ?? {}), characterId: cid, outfit: "rain coat, hood up" }],
      },
    });
    const pv = await alice.get<{ compiledPrompt: string; references: { label: string }[] }>(
      `/api/panels/${panelId}/prompt-preview`,
    );
    expect(pv.references.some((r) => r.label.includes("outfit: Rain Coat"))).toBe(true);
    expect(pv.compiledPrompt).toContain('wears the "Rain Coat" outfit');
  }, 180_000);

  test("BYOK: keys are encrypted, private to their owner and selectable per run", async () => {
    const secret = "sk-test-byok-secret-9876";
    const saved = await alice.post<{ credential: { id: string; keyHint: string; kind: string } }>(
      "/api/ai/credentials",
      { kind: "openai", label: "My OpenAI", apiKey: secret },
      201,
    );
    const credId = saved.credential.id;
    expect(saved.credential.keyHint).toBe("…9876");
    const opts = await alice.get<{ credentials: { id: string }[]; catalog: { kind: string }[] }>("/api/ai/options");
    expect(JSON.stringify(opts)).not.toContain(secret);
    expect(opts.credentials.map((x) => x.id)).toContain(credId);
    expect(opts.catalog.map((x) => x.kind)).toContain("meta");
    const [row] = await h.workerDeps.db.execute<{ encrypted_key: string }>(
      sql`select encrypted_key from provider_credentials where id = ${credId}`,
    );
    expect(row!.encrypted_key).not.toContain(secret);
    expect(row!.encrypted_key.startsWith("v2.")).toBe(true);
    const models = await alice.get<{ models: string[] }>(`/api/ai/credentials/${credId}/models?capability=image`);
    expect(models.models).toContain("gpt-image-2");

    // custom endpoints must be public https
    await alice.post(
      "/api/ai/credentials",
      { kind: "openai_compatible", apiKey: "k-12345678", baseUrl: "http://redis:6379" },
      422,
    );
    // other users can't see, list models for, delete or use the key
    await bob.get(`/api/ai/credentials/${credId}/models`, 404);
    await bob.del(`/api/ai/credentials/${credId}`, 404);
    const bobProject = await bob.post<{ project: { id: string } }>("/api/projects", { title: "Bob" }, 201);
    const bobCh = await bob.post<{ chapter: { id: string } }>(
      `/api/projects/${bobProject.project.id}/chapters`,
      { title: "B", summary: "Bob's chapter" },
      201,
    );
    await bob.post(`/api/chapters/${bobCh.chapter.id}/plan`, { ai: { credentialId: credId, model: "gpt-5" } }, 400);
    // anthropic can't make images
    const ant = await alice.post<{ credential: { id: string } }>(
      "/api/ai/credentials",
      { kind: "anthropic", apiKey: "sk-ant-12345678" },
      201,
    );
    await alice.post(`/api/panels/${panelId}/generate`, { ai: { credentialId: ant.credential.id } }, 400);

    // per-run choices are recorded on the job and survive to completion (mock mode runs them on mock providers)
    const g = await alice.post<{ job: Job }>(
      `/api/panels/${panelId}/generate`,
      { ai: { credentialId: credId, model: "gpt-image-2" } },
      202,
    );
    const done = await waitJob(alice, g.job.id);
    expect(done.job.status).toBe("completed");
    const detail = await alice.get<{
      job: { parameters: { ai?: { credentialId: string; provider: string | null; model: string } } };
    }>(`/api/generations/${g.job.id}`);
    expect(detail.job.parameters.ai).toEqual({ credentialId: credId, provider: null, model: "gpt-image-2" });
    const t = await alice.post<{ job: Job }>(
      `/api/chapters/${chapterId}/narration/generate`,
      { ai: { credentialId: ant.credential.id, model: "claude-sonnet-5" } },
      202,
    );
    expect((await waitJob(alice, t.job.id)).job.status).toBe("completed");

    // voice: a BYOK TTS provider is recorded on audio jobs and its voices are listed
    const eleven = await alice.post<{ credential: { id: string } }>(
      "/api/ai/credentials",
      { kind: "elevenlabs", apiKey: "xi-12345678" },
      201,
    );
    const voices = await alice.get<{ voices: { id: string }[] }>(`/api/ai/voices?credentialId=${eleven.credential.id}`);
    expect(voices.voices.length).toBeGreaterThan(0);
    await alice.post(`/api/chapters/${chapterId}/narration/synthesize`, { ai: { credentialId: credId } }, 202);
    await alice.post(
      `/api/chapters/${chapterId}/narration/synthesize`,
      { ai: { credentialId: ant.credential.id } },
      400,
    );
    const synth = await alice.post<{ queued: number }>(
      `/api/chapters/${chapterId}/narration/synthesize`,
      {
        onlyMissing: false,
        voice: voices.voices[0]!.id,
        ai: { credentialId: eleven.credential.id, model: "eleven_flash_v2_5" },
      },
      202,
    );
    expect(synth.queued).toBeGreaterThan(0);
    const [aj] = await h.workerDeps.db.execute<{
      options: { ai?: { credentialId: string; model: string } };
      voice: string;
    }>(sql`select options, voice from audio_jobs where options ? 'ai' order by created_at desc limit 1`);
    expect(aj!.options.ai).toEqual({ credentialId: eleven.credential.id, model: "eleven_flash_v2_5" });
    expect(aj!.voice).toBe(voices.voices[0]!.id);

    // key rotation: rows written with the old key are re-encrypted with compare-and-set and stay usable
    const { CredentialService, KeyRing, rotateCredentials, credentialKeyStatus } = await import("@openmanga/services");
    const oldKey = "11".repeat(32);
    const newKey = "22".repeat(32);
    const base = h.workerDeps.config;
    const oldSvc = new CredentialService(h.workerDeps.db, { ...base, CREDENTIALS_ENCRYPTION_KEY: oldKey });
    const aliceId = (await alice.get<{ user: { id: string } }>("/api/auth/me")).user.id;
    const legacy = await oldSvc.create(aliceId, { kind: "openai", label: "rotation", apiKey: "sk-rotate-me-4242" });
    const rotatingCfg = { ...base, CREDENTIALS_ENCRYPTION_KEY: newKey, CREDENTIALS_ENCRYPTION_OLD_KEYS: oldKey };
    const rotatingSvc = new CredentialService(h.workerDeps.db, rotatingCfg);
    expect((await rotatingSvc.resolve(legacy.id, aliceId)).apiKey).toBe("sk-rotate-me-4242");
    const ring = new KeyRing(rotatingCfg);
    expect((await credentialKeyStatus(h.workerDeps.db, ring)).pending).toBeGreaterThan(0);
    const r = await rotateCredentials(h.workerDeps.db, ring);
    expect(r.failed).toBe(0);
    expect(r.rotated).toBeGreaterThan(0);
    expect((await credentialKeyStatus(h.workerDeps.db, ring)).pending).toBe(0);
    const newOnly = new CredentialService(h.workerDeps.db, { ...base, CREDENTIALS_ENCRYPTION_KEY: newKey });
    expect((await newOnly.resolve(legacy.id, aliceId)).apiKey).toBe("sk-rotate-me-4242");
    // rotate back so the running app (original key) can still read every row for the remaining tests
    const back = new KeyRing({ ...base, CREDENTIALS_ENCRYPTION_OLD_KEYS: newKey });
    expect((await rotateCredentials(h.workerDeps.db, back)).failed).toBe(0);
    await alice.get(`/api/ai/credentials/${legacy.id}/models`);
    await alice.get("/api/admin/credentials/encryption", 403);

    await alice.del(`/api/ai/credentials/${ant.credential.id}`);
    await alice.post(`/api/chapters/${chapterId}/narration/generate`, { ai: { credentialId: ant.credential.id } }, 400);
  });

  test("budget cap, batch pause/resume and queue recovery", async () => {
    // a model nobody has priced records $0, so the cap cannot see it: it is counted and surfaced instead
    const unpriced = async () =>
      (await alice.get<{ counts: { unpricedCalls: number } }>(`/api/projects/${projectId}`)).counts.unpricedCalls;
    const before = await unpriced();
    await h.workerDeps.usage.record({
      provider: "openrouter",
      model: "unpriced-model",
      operation: "panel_generation",
      projectId,
      imageOutputTokens: 1000,
      images: 1,
    });
    await h.workerDeps.usage.record({
      provider: "kokoro",
      model: "kokoro-82m",
      operation: "tts",
      projectId,
      characters: 500,
      metadata: { local: true },
    });
    const after = await unpriced();
    expect(after).toBe(before + 1); // only the openrouter call: local synthesis is free, not unpriced

    // budget: 0 USD cap refuses new AI work unless explicitly confirmed
    await alice.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 0 } });
    const refused = await alice.raw("POST", `/api/panels/${panelId}/generate`, {});
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("budget_exceeded");
    const est = await alice.post<{ budget: { limitUsd: number; exceeded: boolean; unpricedCalls: number } }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: false },
    );
    expect(est.budget.limitUsd).toBe(0);
    expect(est.budget.unpricedCalls).toBe(after);
    const over = await alice.raw("POST", `/api/panels/${panelId}/generate`, {}, { "x-allow-over-budget": "1" });
    expect(over.status).toBe(202);
    await waitJob(alice, ((await over.json()) as { job: Job }).job.id);
    await alice.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: null } });

    // pause / resume: every job ends up completed, paused jobs are never lost
    const b = await alice.post<{ batchId: string; jobs: { id: string }[] }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { chapterId }, onlyMissing: false, confirm: true },
      202,
    );
    const paused = await alice.post<{ paused: number }>(`/api/generations/batches/${b.batchId}/pause`);
    if (paused.paused > 0) {
      const list = await alice.get<{ batches: { batchId: string; state: string; pauseReason: string | null }[] }>(
        `/api/projects/${projectId}/generations/batches`,
      );
      const mine = list.batches.find((x) => x.batchId === b.batchId)!;
      expect(["paused", "running"]).toContain(mine.state);
      await bob.post(`/api/generations/batches/${b.batchId}/resume`, {}, 404);
      const resumed = await alice.post<{ resumed: number }>(`/api/generations/batches/${b.batchId}/resume`);
      expect(resumed.resumed).toBe(paused.paused);
    }
    await waitFor(
      async () => {
        const r = await alice.get<{ progress: { total: number; completed: number } }>(
          `/api/generations/batches/${b.batchId}`,
        );
        return r.progress.completed === r.progress.total ? r : null;
      },
      { label: "batch completes after resume", timeoutMs: 60_000 },
    );

    // Redis loss recovery: a queued job whose Redis entry is gone gets its outbox row re-armed
    const { JobService } = await import("@openmanga/services");
    const fakeQueue = {
      enqueue: async () => {},
      removeWaiting: async () => true,
      has: async () => false,
      state: async () => null,
      counts: async () => ({}) as never,
      close: async () => {},
    };
    const [ghost] = await h.workerDeps.db.execute<{ id: string }>(sql`
      insert into generation_jobs (project_id, kind, queue, status, created_at, input)
      values (${projectId}, 'story_rewrite', 'text-ai', 'queued', now() - interval '10 minutes', '{"storyRevisionId":"00000000-0000-0000-0000-000000000000","instruction":"x"}')
      returning id`);
    await h.workerDeps.db.execute(
      sql`insert into outbox (queue, job_name, job_id, payload, status, published_at) values ('text-ai', 'story_rewrite', ${ghost!.id}, ${JSON.stringify({ jobId: ghost!.id })}::jsonb, 'published', now())`,
    );
    const svc = new JobService(h.workerDeps.db, { queue: fakeQueue });
    const r = await svc.reconcileQueue(60_000);
    expect(r.republished).toBeGreaterThanOrEqual(1);
    const [ob] = await h.workerDeps.db.execute<{ status: string; attempts: number }>(
      sql`select status, attempts from outbox where job_id = ${ghost!.id}`,
    );
    // Re-armed is the assertion, not the instant it is read in: the harness runs the real dispatcher on a 1s
    // tick, so by now the row is either still pending or already published again with an attempt recorded. The
    // row was inserted as published with 0 attempts, so both outcomes prove reconcile re-armed it.
    expect(ob!.status === "pending" || (ob!.status === "published" && ob!.attempts >= 1)).toBe(true);
    // the real dispatcher publishes it and the worker processes it (fails cleanly: revision doesn't exist)
    await waitJob(alice, ghost!.id);
  });

  test("asset authorization: other users cannot read assets", async () => {
    expect((await bob.raw("GET", `/cdn/a/${artworkAssetId}`)).status).toBe(404);
    expect((await h.client().raw("GET", `/cdn/a/${artworkAssetId}`)).status).toBe(401);
    expect((await alice.raw("GET", `/cdn/a/${artworkAssetId}?v=thumbnail`)).status).toBe(200);
    expect((await alice.raw("GET", "/cdn/a/../../etc/passwd")).status).toBe(404);
  });

  test("usage and cost accounting recorded", async () => {
    const u = await alice.get<{
      operations: { operation: string; calls: number }[];
      windows: Record<string, { calls: number }>;
      breakdown: { byProvider: Record<string, number>; imagesUsd: number; textUsd: number };
      referenceExperiments: { ref_size: string }[];
    }>(`/api/projects/${projectId}/usage`);
    const ops = u.operations.map((o) => o.operation);
    for (const op of [
      "story_analysis",
      "character_reference",
      "chapter_plan",
      "panel_generation",
      "panel_edit",
      "narration_text",
    ])
      expect(ops).toContain(op);
    expect(u.windows.lifetime!.calls).toBeGreaterThan(5);
    // Spend is reported per provider with an image/text split, not per hardcoded provider+modality bucket.
    expect(Object.keys(u.breakdown.byProvider)).toContain("mock");
    expect(u.breakdown.imagesUsd + u.breakdown.textUsd).toBeCloseTo(
      Object.values(u.breakdown.byProvider).reduce((s, x) => s + x, 0),
      6,
    );
    expect(u.referenceExperiments[0]?.ref_size).toBe("192x288");
  });

  test("content-policy hardening: wording lint, stale references, migration guard, preflight", async () => {
    // 1.1 harm vocabulary in prompt-visible fields is reported (personality is not)
    const created = await alice.post<{
      character: { id: string; currentVersionId: string };
      contentWarnings: { field: string; term: string }[];
    }>(
      `/api/projects/${projectId}/characters`,
      {
        name: "Min-ho",
        description: {
          build: "lean and slightly underweight",
          distinctiveFeatures: ["burn scar on the right forearm"],
          personality: "hollowed out by grief",
        },
      },
      201,
    );
    expect(created.contentWarnings.map((w) => `${w.field}:${w.term}`)).toEqual([
      "build:slightly underweight",
      "distinctiveFeatures:burn scar",
    ]);
    const minho = created.character;
    const cast = await alice.get<{ characters: { id: string; contentWarnings: number; staleReferences: number }[] }>(
      `/api/projects/${projectId}/characters`,
    );
    expect(cast.characters.find((c) => c.id === minho.id)!.contentWarnings).toBe(2);

    // 1.2 a reference made before the description changed is stale
    const g = await alice.post<{ job: Job }>(
      `/api/character-versions/${minho.currentVersionId}/references/generate`,
      { kind: "portrait" },
      202,
    );
    expect((await waitJob(alice, g.job.id)).job.status).toBe("completed");
    let detail = await alice.get<{
      versions: { id: string; description: Record<string, unknown>; contentWarnings: unknown[] }[];
      references: { id: string; stale: boolean }[];
    }>(`/api/characters/${minho.id}`);
    expect(detail.references[0]!.stale).toBe(false);
    await alice.post(`/api/references/${detail.references[0]!.id}/status`, { status: "approved" });
    const fixed = await alice.patch<{ contentWarnings: unknown[] }>(
      `/api/character-versions/${minho.currentVersionId}`,
      {
        description: { ...detail.versions[0]!.description, build: "slim", distinctiveFeatures: ["small faded mark"] },
      },
    );
    expect(fixed.contentWarnings).toHaveLength(0);
    detail = await alice.get(`/api/characters/${minho.id}`);
    expect(detail.references[0]!.stale).toBe(true);

    // preflight reports the stale reference for panels that use the version (and the bulk estimate carries it)
    await alice.patch(`/api/panels/${panelId}`, { characterVersionIds: [minho.currentVersionId] });
    const pf = await alice.get<{
      preflight: { panels: number; staleReferences: unknown[]; items: { panelId: string }[] };
    }>(`/api/projects/${projectId}/preflight?chapterId=${chapterId}`);
    expect(pf.preflight.panels).toBeGreaterThan(0);
    expect(pf.preflight.staleReferences).toEqual([
      { characterId: minho.id, name: "Min-ho", versionNumber: 1, panels: 1 },
    ]);
    expect(pf.preflight.items.some((i) => i.panelId === panelId)).toBe(true);
    const est = await alice.post<{ preflight: { staleReferences: unknown[] } }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { panelIds: [panelId] }, onlyMissing: false },
    );
    expect(est.preflight.staleReferences).toHaveLength(1);
    await alice.patch(`/api/panels/${panelId}`, { characterVersionIds: [versionId] });

    // migrating panels onto a version without an approved reference needs an explicit force
    const v2 = await alice.post<{ version: { id: string } }>(
      `/api/characters/${characterId}/versions`,
      { fromVersionId: versionId, makeCurrent: false },
      201,
    );
    const blocked = await alice.raw("POST", `/api/characters/${characterId}/migrate-panels`, {
      fromVersionId: versionId,
      toVersionId: v2.version.id,
    });
    expect(blocked.status).toBe(409);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("no_approved_reference");
    const forced = await alice.post<{ migrated: number }>(`/api/characters/${characterId}/migrate-panels`, {
      fromVersionId: versionId,
      toVersionId: v2.version.id,
      force: true,
    });
    expect(forced.migrated).toBeGreaterThan(0);
    // back onto v1, which has an approved reference: no force needed
    await alice.post(`/api/characters/${characterId}/migrate-panels`, {
      fromVersionId: v2.version.id,
      toVersionId: versionId,
    });
  });

  test("narration pauses, narration style setting, job polling and review flags", async () => {
    await alice.patch(`/api/projects/${projectId}`, {
      settings: { narrationPauseMs: 250, sceneBreakPauseMs: 900, narrationStyle: "dry and warm" },
    });
    const r = await alice.post<{ updated: number }>(`/api/chapters/${chapterId}/narration/pauses`, {});
    expect(r.updated).toBeGreaterThan(0);
    const rows = await h.deps.db.execute<{ pause: number; is_last: boolean }>(
      sql.raw(`select s.pause_after_ms as pause,
          (nl."order" = (select max("order") from narration_lines where chapter_id = '${chapterId}' and language = nl.language)
           and s."order" = (select max("order") from narration_segments where narration_line_id = nl.id)) as is_last
        from narration_segments s join narration_lines nl on nl.id = s.narration_line_id
        where nl.chapter_id = '${chapterId}' and nl.language = 'en'`),
    );
    expect(new Set([...rows].map((x) => x.pause))).toEqual(new Set([250, 900]));
    expect([...rows].find((x) => x.is_last)!.pause).toBe(900);

    // any readable job can be polled by id
    const gens = await alice.get<{ jobs: { id: string }[] }>(`/api/projects/${projectId}/generations`);
    const gen = await alice.get<{ type: string; job: { id: string } }>(`/api/jobs/${gens.jobs[0]!.id}`);
    expect(gen.type).toBe("generation");
    const exps = await alice.get<{ jobs: { id: string }[] }>(`/api/projects/${projectId}/exports`);
    const exp = await alice.get<{ type: string; job: { files: unknown[] } }>(`/api/jobs/${exps.jobs[0]!.id}`);
    expect(exp.type).toBe("export");
    expect(Array.isArray(exp.job.files)).toBe(true);
    expect((await bob.raw("GET", `/api/jobs/${gens.jobs[0]!.id}`)).status).toBeGreaterThanOrEqual(403);

    // content-policy block: one retry on the fallback provider, panel flagged for review, flag dismissable
    const real = new FakeImageAIProvider();
    const fallback = Object.create(real, {
      provider: { value: "mock-fallback" },
      model: { value: "mock-fallback-image" },
      generate: {
        value: (req: Parameters<FakeImageAIProvider["generate"]>[0]) =>
          real.generate({ ...req, prompt: req.prompt.replaceAll("[[mock:policy]]", "") }),
      },
    });
    Object.defineProperty(h.workerDeps.resolver, "defaultImage", { get: () => fallback, configurable: true });
    try {
      // Opt-in under BYOK: there is no shared server key to fall back to, so the project must enable it.
      await alice.patch(`/api/projects/${projectId}`, { settings: { contentPolicyFallback: { enabled: true } } });
      const blocked = await alice.post<{ job: Job }>(
        `/api/panels/${panelId}/generate`,
        { operation: "change_expression", instruction: "[[mock:policy]] smile" },
        202,
      );
      expect((await waitJob(alice, blocked.job.id)).job.status).toBe("completed");
      const before = await alice.get<{ panels: { id: string; review: { reason: string; message: string } | null }[] }>(
        `/api/pages/${pageId}`,
      );
      const review = before.panels.find((p) => p.id === panelId)!.review!;
      expect(review.reason).toBe("content_policy_fallback");
      expect(review.message).toContain("mock-fallback");
      await alice.post(`/api/panels/${panelId}/review/dismiss`, {});
      const after = await alice.get<{ panels: { id: string; review: unknown }[] }>(`/api/pages/${pageId}`);
      expect(after.panels.find((p) => p.id === panelId)!.review).toBeNull();

      // disabled per project: the block fails the job as before
      await alice.patch(`/api/projects/${projectId}`, { settings: { contentPolicyFallback: { enabled: false } } });
      const off = await alice.post<{ job: Job }>(
        `/api/panels/${panelId}/generate`,
        { operation: "change_expression", instruction: "[[mock:policy]] frown" },
        202,
      );
      const offDone = await waitJob(alice, off.job.id);
      expect([offDone.job.status, offDone.job.failureCode]).toEqual(["failed", "content_policy"]);
    } finally {
      delete (h.workerDeps.resolver as unknown as Record<string, unknown>).defaultImage;
      await alice.patch(`/api/projects/${projectId}`, { settings: { contentPolicyFallback: { enabled: true } } });
    }
  });

  test("delete chapter: blocked while generating, cascades, renumbers the rest", async () => {
    const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Delete chapters" }, 201);
    const pid = p.project.id;
    const ids: string[] = [];
    for (const title of ["One", "Two", "Three"]) {
      const r = await alice.post<{ chapter: { id: string } }>(`/api/projects/${pid}/chapters`, { title }, 201);
      ids.push(r.chapter.id);
    }
    await bob.del(`/api/chapters/${ids[1]}`, 404);

    await h.workerDeps.db.execute(
      sql`insert into generation_jobs (project_id, kind, queue, status, target_type, target_id) values (${pid}, 'chapter_plan', 'text-ai', 'processing', 'chapter', ${ids[1]})`,
    );
    await alice.del(`/api/chapters/${ids[1]}`, 409);
    await h.workerDeps.db.execute(sql`update generation_jobs set status = 'failed' where target_id = ${ids[1]}`);

    await alice.del(`/api/chapters/${ids[1]}`);
    await alice.get(`/api/chapters/${ids[1]}`, 404);
    const list = await alice.get<{ chapters: { id: string; order: number; title: string }[] }>(
      `/api/projects/${pid}/chapters`,
    );
    expect(list.chapters.map((c) => [c.title, c.order])).toEqual([
      ["One", 1],
      ["Three", 2],
    ]);
  });

  test("duplicate, search, archive, trash", async () => {
    const s = await alice.get<{ characters: { name: string }[]; dialogue: unknown[] }>(
      `/api/projects/${projectId}/search?q=woo`,
    );
    expect(s.characters.length).toBeGreaterThan(0);
    const dup = await alice.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
    const ov = await alice.get<{ counts: { panels: number; characters: number } }>(`/api/projects/${dup.project.id}`);
    expect(ov.counts.characters).toBeGreaterThanOrEqual(2);
    expect(ov.counts.panels).toBeGreaterThan(0);
    await alice.post(`/api/projects/${dup.project.id}/status`, { action: "trash" });
    await alice.del(`/api/projects/${dup.project.id}`);
  }, 60_000);
});

describe("failure handling", () => {
  let projectId = "";
  test("non-retryable provider failure marks job failed with a safe message", async () => {
    const p = await alice.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Broken", story: { content: "A story that breaks auth [[mock:auth]]. Mina ran. Mina hid." } },
      201,
    );
    projectId = p.project.id;
    const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
    const r = await alice.post<{ job: Job; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    const done = await waitJob(alice, r.job.id);
    expect(done.job.status).toBe("failed");
    expect(done.job.failureCode).toBe("auth");
    expect(done.job.failureReason).not.toContain("at ");
    const a = await alice.get<{ analysis: { status: string } }>(`/api/story-analyses/${r.analysis.id}`);
    expect(a.analysis.status).toBe("failed");
  });

  test("unrepairable JSON fails clearly; repairable JSON succeeds with one repair call", async () => {
    const mk = async (marker: string) => {
      const rev = await alice.post<{ revision: { id: string } }>(
        `/api/projects/${projectId}/story/revisions`,
        { content: `Mina ran to the station. Mina waited. ${marker}` },
        201,
      );
      const r = await alice.post<{ job: Job }>(`/api/story-revisions/${rev.revision.id}/analyze`, {}, 202);
      return waitJob(alice, r.job.id);
    };
    const bad = await mk("[[mock:invalid-json]]");
    expect(bad.job.status).toBe("failed");
    expect(bad.job.failureCode).toBe("invalid_json");
    const good = (await mk("[[mock:repairable]]")) as unknown as {
      job: Job;
      usage: { metadata: { purpose: string } }[];
    };
    expect(good.job.status).toBe("completed");
    expect(good.usage.map((u) => u.metadata.purpose)).toEqual(["primary", "repair"]);
  });

  test("content policy uses its retry budget, then fails; a retried job points at its replacement", async () => {
    const chars = await alice.post<{ character: { currentVersionId: string } }>(
      `/api/projects/${projectId}/characters`,
      { name: "Mina", description: { hair: "red [[mock:policy]]" } },
      201,
    );
    const r = await alice.post<{ job: Job }>(
      `/api/character-versions/${chars.character.currentVersionId}/references/generate`,
      { kind: "portrait" },
      202,
    );
    const done = await waitJob(alice, r.job.id);
    expect(done.job.status).toBe("failed");
    expect(done.job.failureCode).toBe("content_policy");
    // The filter is nondeterministic, so blocks now use the attempt budget instead of failing on the first try.
    expect((done.job as unknown as { attempts: number }).attempts).toBeGreaterThan(1);
    const retried = await alice.post<{ job: Job }>(`/api/generations/${r.job.id}/retry`, {}, 202);
    expect(retried.job.id).not.toBe(r.job.id);
    const list = await alice.get<{ jobs: { id: string; retriedByJobId: string | null }[] }>(
      `/api/projects/${projectId}/generations`,
    );
    expect(list.jobs.find((j) => j.id === r.job.id)?.retriedByJobId).toBe(retried.job.id);
    // Retrying the same failure twice would pay for the same image again.
    await alice.post(`/api/generations/${r.job.id}/retry`, {}, 409);
    await waitJob(alice, retried.job.id);
    await alice.post(`/api/generations/${retried.job.id}/cancel`, {}, 409);
  });
});

describe("list endpoints with correlated subqueries", () => {
  test("generation list exposes output asset and cost; chapter pages expose panel counts", async () => {
    const projects = await alice.get<{ projects: { id: string; title: string }[] }>("/api/projects");
    const p = projects.projects.find((x) => x.title === "Rain City")!;
    const jobs = await alice.get<{ jobs: { kind: string; status: string; outputAssetId: string | null }[] }>(
      `/api/projects/${p.id}/generations?kind=panel_generation&status=completed`,
    );
    expect(jobs.jobs.length).toBeGreaterThan(0);
    expect(jobs.jobs.every((j) => j.outputAssetId)).toBe(true);
    const chs = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${p.id}/chapters`);
    const ch = await alice.get<{ pages: { panelCount: number; readyCount: number }[] }>(
      `/api/chapters/${chs.chapters[0]!.id}`,
    );
    expect(ch.pages[0]!.panelCount).toBeGreaterThan(0);
    expect(ch.pages.some((pg) => pg.readyCount > 0)).toBe(true);
  });
});
