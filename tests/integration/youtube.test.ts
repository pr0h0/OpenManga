import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, projectMembers, sql, youtubeChannels } from "@openmanga/db";
import {
  credentialKeyStatus,
  FakeYouTubeClient,
  KeyRing,
  rotateCredentials,
  YouTubeService,
} from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
let alice: TestClient;
let bob: TestClient;
let projectId = "";

type Channel = { id: string; channelId: string; title: string; status: string; reportingReady: boolean };
type Link = {
  id: string;
  videoId: string;
  kind: "film" | "short";
  channelTitle: string | null;
  connection: { id: string } | null;
  counts: { views: number; source: string } | null;
  curve48: (number | null)[] | null;
  impressions: number | null;
  shortLabel: string | null;
};
type Summary = {
  enabled: boolean;
  links: Link[];
  totals: {
    all: { videos: number; views: number };
    film: { videos: number; views: number };
    short: { videos: number; views: number };
    byChannel: { channelId: string; videos: number }[];
  };
};

const PASTED = "dQw4w9WgXcQ";

/** The whole browser round trip: start, the fake consent screen, Google's redirect back to the callback. */
async function connect(c: TestClient, channel: string) {
  const { url } = await c.post<{ url: string }>("/api/youtube/connect", { returnTo: `/projects/${projectId}/youtube` });
  const consent = new URL(url);
  expect(consent.pathname).toBe("/api/youtube/fake-consent");
  const page = await c.raw("GET", `${consent.pathname}${consent.search}`);
  expect(await page.text()).toContain("Fake Google");
  const allow = await c.raw(
    "GET",
    `/api/youtube/fake-consent?state=${consent.searchParams.get("state")}&channel=${encodeURIComponent(channel)}`,
  );
  const cb = new URL(allow.headers.get("location")!);
  expect(cb.pathname).toBe("/api/youtube/oauth/callback");
  const back = await c.raw("GET", `${cb.pathname}${cb.search}`);
  return new URL(back.headers.get("location")!);
}

const channels = (c: TestClient) =>
  c.get<{ enabled: boolean; mock: boolean; channels: Channel[] }>("/api/youtube/channels");
const summary = (c: TestClient = alice) => c.get<Summary>(`/api/projects/${projectId}/youtube`);
const count = async (q: ReturnType<typeof sql>) => Number((await h.deps.db.execute<{ n: number }>(q))[0]!.n);

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "ytalice", email: "yta@example.com", password: "youtube pass 1" },
    201,
  );
  await bob.post(
    "/api/auth/register",
    { username: "ytbob", email: "ytb@example.com", password: "youtube pass 2" },
    201,
  );
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Stats" }, 201)).project.id;
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

describe("connecting channels", () => {
  test("mock mode connects through the fake consent screen and creates the reach reporting jobs", async () => {
    expect((await channels(alice)).mock).toBe(true);
    // Coming back only ever lands inside the app.
    await alice.post("/api/youtube/connect", { returnTo: "//evil.example/x" }, 422);
    const back = await connect(alice, "Alpha");
    expect(back.pathname).toBe(`/app/projects/${projectId}/youtube`);
    expect(back.searchParams.get("youtube_connected")).toBe("Alpha");
    await connect(alice, "Beta");
    const list = (await channels(alice)).channels;
    expect(list.map((c) => c.title)).toEqual(["Alpha", "Beta"]);
    expect(list.every((c) => c.reportingReady && c.status === "active")).toBe(true);
    // Tokens are encrypted at rest.
    const [row] = await h.deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, list[0]!.id));
    expect(row!.encryptedRefreshToken.startsWith("v2.")).toBe(true);
    expect(row!.encryptedRefreshToken).not.toContain("fake-refresh");
    expect(row!.reporting.basic?.jobId).toContain("channel_reach_basic_a1");
    expect(row!.reporting.combined?.jobId).toContain("channel_reach_combined_a1");
    // Connecting the same channel again replaces its tokens rather than adding a second one.
    await connect(alice, "Alpha");
    expect((await channels(alice)).channels).toHaveLength(2);
  });

  test("a consent state is single use and bound to the account that started it", async () => {
    const { url } = await alice.post<{ url: string }>("/api/youtube/connect", {});
    const state = new URL(url).searchParams.get("state")!;
    const r = await bob.raw("GET", `/api/youtube/oauth/callback?state=${state}&code=fake.Stolen`);
    expect(new URL(r.headers.get("location")!).searchParams.get("youtube_error")).toContain("expired");
    expect((await channels(bob)).channels).toHaveLength(0);
    // Used up by the attempt above.
    const again = await alice.raw("GET", `/api/youtube/oauth/callback?state=${state}&code=fake.Alpha`);
    expect(new URL(again.headers.get("location")!).searchParams.get("youtube_error")).toBeTruthy();
    // Cancelling on the consent screen.
    const { url: u2 } = await alice.post<{ url: string }>("/api/youtube/connect", {});
    const deny = await alice.raw(
      "GET",
      `/api/youtube/fake-consent?state=${new URL(u2).searchParams.get("state")}&deny=1`,
    );
    const cb = new URL(deny.headers.get("location")!);
    const back = await alice.raw("GET", `${cb.pathname}${cb.search}`);
    expect(new URL(back.headers.get("location")!).searchParams.get("youtube_error")).toBe("Access was not granted.");
  });

  test("uploads are listed page by page, only for the owner", async () => {
    const [alpha] = (await channels(alice)).channels;
    const p1 = await alice.get<{ items: { videoId: string }[]; next: string | null }>(
      `/api/youtube/channels/${alpha!.id}/uploads`,
    );
    expect(p1.items).toHaveLength(10);
    expect(p1.next).toBe("10");
    const p2 = await alice.get<{ items: unknown[]; next: string | null }>(
      `/api/youtube/channels/${alpha!.id}/uploads?pageToken=10`,
    );
    expect(p2.items).toHaveLength(4);
    expect(p2.next).toBeNull();
    await bob.get(`/api/youtube/channels/${alpha!.id}/uploads`, 404);
    await bob.del(`/api/youtube/channels/${alpha!.id}`, 404);
  });
});

describe("linking videos", () => {
  const alphaVideo = (i: number) => `${FakeYouTubeClient.prefix("Alpha")}${String(i).padStart(3, "0")}`;
  const betaVideo = (i: number) => `${FakeYouTubeClient.prefix("Beta")}${String(i).padStart(3, "0")}`;

  test("links from uploads and pasted links across channels, with kinds and sources", async () => {
    await alice.patch(`/api/projects/${projectId}`, {
      settings: { repurpose: { items: [{ id: "s1", kind: "short", label: "Hook cut" }] } },
    });
    const film = await alice.post<{ link: { connectionId: string | null; kind: string } }>(
      `/api/projects/${projectId}/youtube/links`,
      { video: alphaVideo(0), label: "Premiere" },
      201,
    );
    expect(film.link.connectionId).toBeTruthy();
    expect(film.link.kind).toBe("film");
    // The fake's clock decides how fresh its newest upload is; pin it: five hours old, so in its first 48 hours.
    await h.deps.db.execute(
      sql`update youtube_links set published_at = now() - interval '5 hours' where video_id = ${alphaVideo(0)}`,
    );
    // A 45-second upload reads as a Short; it names the Short of the plan it came from.
    const short = await alice.post<{ link: { kind: string } }>(
      `/api/projects/${projectId}/youtube/links`,
      { video: `https://youtube.com/shorts/${alphaVideo(2)}?si=abc`, shortId: "s1" },
      201,
    );
    expect(short.link.kind).toBe("short");
    // Same film on a second channel (a dub), by a youtu.be link with a timestamp.
    await alice.post(
      `/api/projects/${projectId}/youtube/links`,
      { video: `https://youtu.be/${betaVideo(0)}?t=42` },
      201,
    );
    await h.deps.db.execute(
      sql`update youtube_links set published_at = now() - interval '100 hours' where video_id = ${betaVideo(0)}`,
    );
    // Someone else's video: no connection, public counters only.
    const other = await alice.post<{ link: { connectionId: string | null } }>(
      `/api/projects/${projectId}/youtube/links`,
      { video: `https://m.youtube.com/watch?v=${PASTED}&list=PL1`, kind: "film" },
      201,
    );
    expect(other.link.connectionId).toBeNull();

    await alice.post(
      `/api/projects/${projectId}/youtube/links`,
      { video: `https://www.youtube.com/watch?v=${PASTED}` },
      409,
    );
    await alice.post(
      `/api/projects/${projectId}/youtube/links`,
      { video: "https://www.youtube.com/playlist?list=PL123" },
      400,
    );
    await alice.post(`/api/projects/${projectId}/youtube/links`, { video: alphaVideo(3), shortId: "nope" }, 400);
    await alice.post(
      `/api/projects/${projectId}/youtube/links`,
      { video: alphaVideo(3), exportId: "00000000-0000-4000-8000-000000000000" },
      400,
    );
  });

  test("the project page sums every video, film against Shorts, per channel, with first-48-hours curves", async () => {
    const s = await summary();
    expect(s.links).toHaveLength(4);
    expect(s.totals.all.videos).toBe(4);
    expect(s.totals.film.videos).toBe(3);
    expect(s.totals.short.videos).toBe(1);
    expect(s.totals.all.views).toBe(s.totals.film.views + s.totals.short.views);
    expect(s.totals.byChannel).toHaveLength(3);
    expect(s.links.every((l) => l.counts?.source === "live")).toBe(true);
    expect(s.links.find((l) => l.kind === "short")?.shortLabel).toBe("Hook cut");
    // The newest fake upload is under two days old: its link snapshot is the curve's first measured point.
    const fresh = s.links.find((l) => l.videoId === alphaVideo(0))!;
    expect(fresh.curve48?.[0]).toBe(0);
    expect(fresh.curve48?.[4]).toBeGreaterThan(0);
    expect(fresh.curve48?.[6]).toBeNull();
  });

  test("a connected video gets its reach reports backfilled, unconnected ones none", async () => {
    await waitFor(
      async () =>
        (await count(sql`select count(*)::int as n from youtube_reach where video_id = ${alphaVideo(2)}`)) > 0,
      { label: "reach backfill", timeoutMs: 30_000 },
    );
    // Only rows of linked videos are kept: Alpha has 14 uploads, 2 are linked.
    const kept = await count(sql`select count(distinct video_id)::int as n from youtube_reach`);
    expect(kept).toBeLessThanOrEqual(3);
    expect(await count(sql`select count(*)::int as n from youtube_reach where video_id = ${PASTED}`)).toBe(0);
    const s = await summary();
    expect(s.links.find((l) => l.videoId === alphaVideo(2))!.impressions).toBeGreaterThan(0);
    expect(s.links.find((l) => l.videoId === PASTED)!.impressions).toBeNull();
  });

  test("history: Analytics for a connected channel, snapshots otherwise", async () => {
    const s = await summary();
    const connected = s.links.find((l) => l.videoId === alphaVideo(2))!;
    const hist = await alice.get<{
      source: string;
      daily: { day: string; views: number; averageViewPercentage: number }[];
      splits: Record<string, { views: number }[]>;
      tail: { after: string; views: number } | null;
      reach: { daily: { impressions: number; ctr: number }[]; bySource: { trafficSource: string }[] };
    }>(`/api/projects/${projectId}/youtube/links/${connected.id}/history`);
    expect(hist.source).toBe("analytics");
    expect(hist.daily.length).toBeGreaterThan(1);
    expect(hist.daily[0]).toHaveProperty("averageViewPercentage");
    expect(Object.keys(hist.splits)).toEqual(["trafficSource", "country", "device", "contentType"]);
    expect(hist.splits.contentType![0]).toMatchObject({ creatorContentType: "SHORTS" });
    expect(hist.tail?.views).toBeGreaterThanOrEqual(0);
    expect(hist.reach.daily.length).toBeGreaterThan(0);
    expect(hist.reach.daily[0]!.ctr).toBeGreaterThan(0);
    expect(hist.reach.bySource.map((x) => x.trafficSource).sort()).toEqual(["3", "5", "7"]);
    // Cached: the second open does not ask Google again.
    expect(await h.deps.redis.exists(`yt:analytics:${connected.id}`)).toBe(1);

    const pasted = s.links.find((l) => l.videoId === PASTED)!;
    const h2 = await alice.get<{ source: string; splits: unknown; reach: { daily: unknown[] } }>(
      `/api/projects/${projectId}/youtube/links/${pasted.id}/history`,
    );
    expect(h2.source).toBe("snapshots");
    expect(h2.splits).toBeNull();
    expect(h2.reach.daily).toEqual([]);
  });

  test("other users see nothing, and cannot use someone else's connection", async () => {
    await bob.get(`/api/projects/${projectId}/youtube`, 404);
    const s = await summary();
    await bob.get(`/api/projects/${projectId}/youtube/links/${s.links[0]!.id}/history`, 404);
    await bob.post(`/api/projects/${projectId}/youtube/links`, { video: PASTED }, 404);
    await bob.del(`/api/projects/${projectId}/youtube/links/${s.links[0]!.id}`, 404);
    // Bob links Alice's video in his own project: public counters, no analytics, no reach.
    const own = (await bob.post<{ project: { id: string } }>("/api/projects", { title: "Bob" }, 201)).project.id;
    const r = await bob.post<{ link: { id: string; connectionId: string | null } }>(
      `/api/projects/${own}/youtube/links`,
      { video: alphaVideo(2) },
      201,
    );
    expect(r.link.connectionId).toBeNull();
    const hist = await bob.get<{ source: string; reach: { daily: unknown[] } }>(
      `/api/projects/${own}/youtube/links/${r.link.id}/history`,
    );
    expect(hist.source).toBe("snapshots");
    expect(hist.reach.daily).toEqual([]);
  });

  test("a member who leaves takes their channel's grant with them, and reconnecting does not bring it back", async () => {
    const gamma = `${FakeYouTubeClient.prefix("Gamma")}000`;
    const [b] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'ytbob'`);
    await h.deps.db.insert(projectMembers).values({ projectId, userId: b!.id, role: "editor" });
    await connect(bob, "Gamma");
    const r = await bob.post<{ link: { id: string; connectionId: string | null } }>(
      `/api/projects/${projectId}/youtube/links`,
      { video: gamma },
      201,
    );
    expect(r.link.connectionId).toBeTruthy();
    await alice.del(`/api/projects/${projectId}/members/${b!.id}`);
    const after = (await summary()).links.find((l) => l.id === r.link.id)!;
    expect(after.connection).toBeNull();
    // Reconnecting the channel re-attaches links only in projects Bob still belongs to.
    await connect(bob, "Gamma");
    expect((await summary()).links.find((l) => l.id === r.link.id)!.connection).toBeNull();
    await alice.del(`/api/projects/${projectId}/youtube/links/${r.link.id}`);
  });

  test("edit and unlink", async () => {
    const s = await summary();
    const pasted = s.links.find((l) => l.videoId === PASTED)!;
    const r = await alice.patch<{ link: { kind: string; label: string } }>(
      `/api/projects/${projectId}/youtube/links/${pasted.id}`,
      { kind: "short", label: "Reupload" },
    );
    expect(r.link).toMatchObject({ kind: "short", label: "Reupload" });
    await alice.patch(`/api/projects/${projectId}/youtube/links/${pasted.id}`, { kind: "film" });
  });
});

describe("snapshots and retention", () => {
  const H = 3600_000;

  test("hourly in the first 48 hours, then daily only for unconnected channels", async () => {
    const yt = h.workerDeps.youtube;
    await h.deps.db.execute(sql`delete from youtube_snapshots`);
    const at = (ms: number) => new Date(Date.now() + ms);
    const fresh = await count(
      sql`select count(distinct video_id)::int as n from youtube_links where published_at > now() - interval '47 hours'`,
    );
    const unconnectedOld = await count(sql`
      select count(distinct l.video_id)::int as n from youtube_links l
      where l.published_at < now() - interval '47 hours'
        and not exists (select 1 from youtube_links c where c.video_id = l.video_id and c.connection_id is not null)`);
    expect(fresh).toBe(1);
    expect(unconnectedOld).toBe(1);
    // Fresh uploads and videos on channels nobody connected; an older connected video has Analytics instead.
    expect(await yt.takeSnapshots(at(0))).toBe(fresh + unconnectedOld);
    // 30 minutes later: nothing is due.
    expect(await yt.takeSnapshots(at(0.5 * H))).toBe(0);
    // An hour on: only videos in their first 48 hours.
    expect(await yt.takeSnapshots(at(1.01 * H))).toBe(fresh);
    // A day on: the fresh ones again, and the daily snapshot of unconnected ones.
    expect(await yt.takeSnapshots(at(25 * H))).toBe(fresh + unconnectedOld);
    // Counters read with the owning channel's token are authorized; the rest are not.
    expect(
      await count(sql`select count(*)::int as n from youtube_snapshots where video_id = ${PASTED} and authorized`),
    ).toBe(0);
    expect(
      await count(sql`select count(*)::int as n from youtube_snapshots where authorized and connection_id is not null`),
    ).toBeGreaterThan(0);
  });

  test("the hourly pass runs from the maintenance queue", async () => {
    const r = await h.workerDeps.youtube.hourly();
    expect(r).toHaveProperty("snapshots");
    expect(r).toHaveProperty("expiredUnauthorized");
  });

  test("unauthorized statistics are kept 30 days; unlinked and unverified data is deleted", async () => {
    const yt = h.workerDeps.youtube;
    const db = h.deps.db;
    const [alpha] = (await channels(alice)).channels;
    await db.execute(sql`
      insert into youtube_snapshots (video_id, taken_at, views, authorized) values
        (${PASTED}, now() - interval '31 days', 1, false),
        (${PASTED}, now() - interval '29 days', 2, false),
        ('zzzzzzzzzzz', now(), 3, false)`);
    await db.execute(sql`
      insert into youtube_snapshots (video_id, taken_at, views, authorized, connection_id)
      select video_id, now() - interval '200 days', 4, true, connection_id from youtube_links where connection_id = ${alpha!.id} limit 1`);
    const r = await yt.retention();
    expect(r.expiredUnauthorized).toBe(1);
    expect(r.unlinkedSnapshots).toBe(1);
    expect(await count(sql`select count(*)::int as n from youtube_snapshots where views = 2`)).toBe(1);
    expect(await count(sql`select count(*)::int as n from youtube_snapshots where views = 4`)).toBe(1);
    // A channel whose authorization has not been re-confirmed for 30 days loses what is stored under it.
    await db.execute(sql`update youtube_channels set verified_at = now() - interval '31 days' where id = ${alpha!.id}`);
    expect((await yt.retention()).unverifiedChannels).toBe(1);
    expect(await count(sql`select count(*)::int as n from youtube_reach where connection_id = ${alpha!.id}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from youtube_snapshots where connection_id = ${alpha!.id}`)).toBe(
      0,
    );
    await db.execute(sql`update youtube_channels set verified_at = now() where id = ${alpha!.id}`);
  });

  test("a grant revoked at Google marks the channel and deletes its data", async () => {
    await connect(alice, "revoked-channel");
    const ch = (await channels(alice)).channels.find((c) => c.title === "revoked-channel")!;
    await h.deps.db.execute(sql`
      insert into youtube_reach (connection_id, video_id, day, source, impressions) values (${ch.id}, 'xxxxxxxxxxx', '2026-01-01', '', 5)`);
    await h.deps.db.execute(sql`update youtube_channels set access_token_expires_at = now() where id = ${ch.id}`);
    const [row] = await h.deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, ch.id));
    await expect(h.workerDeps.youtube.accessToken(row!)).rejects.toThrow();
    expect((await channels(alice)).channels.find((c) => c.id === ch.id)!.status).toBe("revoked");
    expect(await count(sql`select count(*)::int as n from youtube_reach where connection_id = ${ch.id}`)).toBe(0);
    await alice.del(`/api/youtube/channels/${ch.id}`);
  });
});

describe("agents", () => {
  test("get_youtube_stats reads the summary and one video's history with stats:read", async () => {
    const t = await alice.post<{ token: string }>(
      "/api/agents/tokens",
      { name: "Stats agent", scopes: ["stats:read"], projectAccess: "all", approvalMode: "ALLOW_ALL" },
      201,
    );
    const client = new Client({ name: "test-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${t.token}`, host: "test.local" } },
        fetch: (url, init) => Promise.resolve(h.app.request(String(url), init as RequestInit)),
      }),
    );
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: "get_youtube_stats", arguments: args });
      expect(r.isError).toBeFalsy();
      return r.structuredContent as { data: Record<string, unknown> };
    };
    const s = (await call({ projectId })).data as unknown as Summary;
    expect(s.links.length).toBe(4);
    const hist = (await call({ projectId, linkId: s.links[0]!.id })).data;
    expect(hist).toHaveProperty("daily");
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("get_youtube_stats");
    expect(names).not.toContain("list_projects");
    await client.close();
  });
});

describe("disconnecting", () => {
  test("revokes and deletes the channel's stored data; links stay as unconnected videos", async () => {
    const [alpha] = (await channels(alice)).channels;
    await h.workerDeps.youtube.ingestReports(
      (await h.deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, alpha!.id)))[0]!,
      { full: true },
    );
    expect(
      await count(sql`select count(*)::int as n from youtube_reach where connection_id = ${alpha!.id}`),
    ).toBeGreaterThan(0);
    await alice.del(`/api/youtube/channels/${alpha!.id}`);
    expect(await count(sql`select count(*)::int as n from youtube_reach where connection_id = ${alpha!.id}`)).toBe(0);
    expect(await count(sql`select count(*)::int as n from youtube_snapshots where connection_id = ${alpha!.id}`)).toBe(
      0,
    );
    const s = await summary();
    expect(s.links).toHaveLength(4);
    expect(s.links.filter((l) => l.connection).length).toBe(1); // only Beta's
  });
});

describe("key rotation", () => {
  test("channel tokens are re-encrypted with the provider keys and keep working", async () => {
    const base = h.workerDeps.config;
    const newKey = "33".repeat(32);
    // The test app runs on the SESSION_SECRET-derived key, which every ring can still decrypt.
    const ring = new KeyRing({ ...base, CREDENTIALS_ENCRYPTION_KEY: newKey });
    expect((await credentialKeyStatus(h.deps.db, ring)).pending).toBeGreaterThan(0);
    const r = await rotateCredentials(h.deps.db, ring);
    expect(r.failed).toBe(0);
    expect((await credentialKeyStatus(h.deps.db, ring)).pending).toBe(0);
    const [beta] = await h.deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.title, "Beta"));
    expect(beta!.encryptedAccessToken).toBeNull();
    const yt = new YouTubeService(h.deps.db, h.deps.youtube.client, ring, base);
    expect(await yt.accessToken(beta!)).toStartWith("fake-access.Beta.");
    // Back onto the app's own key for anything after this.
    expect(
      (await rotateCredentials(h.deps.db, new KeyRing({ ...base, CREDENTIALS_ENCRYPTION_OLD_KEYS: newKey }))).failed,
    ).toBe(0);
  });
});
