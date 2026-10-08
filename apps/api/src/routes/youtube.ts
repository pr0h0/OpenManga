import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  exportsTable,
  gte,
  inArray,
  sql,
  youtubeChannels,
  youtubeLinks,
  youtubeReach,
  youtubeSnapshots,
} from "@openmanga/db";
import { first48Curve, isShortsUrl, parseYouTubeVideoId } from "@openmanga/domain";
import { YouTubeError, type YoutubeChannelRow, type YtVideo } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

type Deps = AppEnv["Variables"]["deps"];
type Link = typeof youtubeLinks.$inferSelect;

/** Live counters are re-read at most this often per project; Analytics answers are cached a little longer. */
const LIVE_TTL_S = 300;
const ANALYTICS_TTL_S = 900;
const STATE_TTL_S = 600;
const MAX_LINKS = 200;
const DAY = 86400_000;

const ytError = (e: unknown): never => {
  if (e instanceof YouTubeError) {
    const status =
      e.code === "revoked"
        ? 409
        : e.code === "quota"
          ? 429
          : e.code === "not_found"
            ? 404
            : e.code === "not_enabled"
              ? 422
              : 503;
    throw new ApiError(status, `youtube_${e.code}`, e.message);
  }
  throw e;
};

function enabledService(c: Context<AppEnv>) {
  const yt = c.get("deps").youtube;
  if (!yt.enabled)
    throw new ApiError(
      503,
      "youtube_not_configured",
      "YouTube stats are not set up on this server: an administrator sets GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET",
    );
  return yt;
}

const channelView = (r: YoutubeChannelRow) => ({
  id: r.id,
  channelId: r.channelId,
  title: r.title,
  thumbnailUrl: r.thumbnailUrl,
  status: r.status,
  reportingReady: Boolean(r.reporting.basic && r.reporting.combined),
  reportingError: r.reportingError,
  reportsCheckedAt: r.reporting.checkedAt ?? null,
  verifiedAt: r.verifiedAt,
  createdAt: r.createdAt,
});

async function ownChannel(c: Context<AppEnv>, id: string) {
  const [row] = await c
    .get("deps")
    .db.select()
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.id, id), eq(youtubeChannels.userId, user(c).id)));
  if (!row) throw notFound("YouTube channel");
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Account: connecting channels. Mounted on the browser's /api only, never on the router MCP tools call.

export const youtubeAccountRoutes = new Hono<AppEnv>();

doc({ method: "GET", path: "/api/youtube/channels", summary: "Your connected YouTube channels", tag: "youtube" });
youtubeAccountRoutes.get("/channels", async (c) => {
  const deps = c.get("deps");
  const rows = await deps.db
    .select()
    .from(youtubeChannels)
    .where(eq(youtubeChannels.userId, user(c).id))
    .orderBy(asc(youtubeChannels.createdAt));
  return c.json({
    enabled: deps.youtube.enabled,
    mock: Boolean(deps.youtube.client?.fake),
    apiKey: Boolean(deps.config.YOUTUBE_API_KEY),
    channels: rows.map(channelView),
  });
});

const ConnectInput = z.object({
  /** An app path to come back to, e.g. /projects/<id>/youtube. */
  returnTo: z
    .string()
    .max(300)
    .regex(/^(\/[\w-]+)+$/)
    .optional(),
});
doc({
  method: "POST",
  path: "/api/youtube/connect",
  summary:
    "Start connecting a YouTube channel (read-only scopes): returns Google's consent URL to open. Each channel, brand channels included, is its own connection.",
  tag: "youtube",
  body: ConnectInput,
});
youtubeAccountRoutes.post("/connect", async (c) => {
  const yt = enabledService(c);
  const { returnTo } = await body(c, ConnectInput);
  const deps = c.get("deps");
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  await deps.redis.set(
    `yt:oauth:${state}`,
    JSON.stringify({ userId: user(c).id, verifier, returnTo: returnTo ?? null }),
    "EX",
    STATE_TTL_S,
  );
  const codeChallenge = createHash("sha256").update(verifier).digest("base64url");
  return c.json({ url: yt.client!.authUrl({ state, redirectUri: callbackUrl(deps), codeChallenge }) });
});

const callbackUrl = (deps: Deps) => deps.urls.apiUrl("youtube/oauth/callback");

youtubeAccountRoutes.get("/oauth/callback", async (c) => {
  const deps = c.get("deps");
  const q = c.req.query();
  const raw = q.state ? await deps.redis.getdel(`yt:oauth:${q.state}`) : null;
  const st = raw ? (JSON.parse(raw) as { userId: string; verifier: string; returnTo: string | null }) : null;
  const back = (params: Record<string, string>) =>
    c.redirect(deps.urls.appUrl((st?.returnTo ?? "/account").replace(/^\//, ""), params));
  // The state is single use and bound to the account that started the flow: a link from someone else does nothing.
  if (!st || st.userId !== user(c).id) return back({ youtube_error: "This connection attempt expired; try again." });
  if (q.error || !q.code)
    return back({ youtube_error: q.error === "access_denied" ? "Access was not granted." : q.error || "No code" });
  try {
    const yt = enabledService(c);
    const t = await yt.client!.exchangeCode({
      code: q.code,
      redirectUri: callbackUrl(deps),
      codeVerifier: st.verifier,
    });
    const conn = await yt.connect(st.userId, t);
    return back({ youtube_connected: conn.title });
  } catch (e) {
    deps.logger.warn("youtube connect failed", { error: (e as Error).message });
    return back({ youtube_error: (e as Error).message.slice(0, 200) });
  }
});

/** AI_MOCK_MODE only: the fake Google consent screen. Choosing a name connects a fake channel of that name. */
youtubeAccountRoutes.get("/fake-consent", (c) => {
  const yt = c.get("deps").youtube;
  if (!yt.client?.fake) throw notFound();
  const { state = "", channel, deny } = c.req.query();
  const cb = new URL(callbackUrl(c.get("deps")));
  if (deny || channel !== undefined) {
    cb.searchParams.set("state", state);
    if (deny) cb.searchParams.set("error", "access_denied");
    else
      cb.searchParams.set(
        "code",
        `fake.${(channel || "My channel").replace(/[^\w .-]/g, "").slice(0, 60) || "My channel"}`,
      );
    return c.redirect(cb.toString());
  }
  const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fake Google consent</title><style>body{font:16px system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem}input,button{font:inherit;padding:.4rem .6rem}</style></head>
<body><h1>Fake Google</h1><p>OpenManga is in mock mode: no real Google account is used. This channel gets read-only access
(<code>youtube.readonly</code>, <code>yt-analytics.readonly</code>).</p>
<form method="get"><input type="hidden" name="state" value="${esc(state)}">
<label>Channel name <input name="channel" value="My channel" maxlength="60"></label>
<p><button type="submit">Allow</button> <button type="submit" name="deny" value="1">Cancel</button></p></form></body></html>`);
});

doc({
  method: "DELETE",
  path: "/api/youtube/channels/:id",
  summary:
    "Disconnect a YouTube channel: revokes the grant at Google and deletes its tokens, reach reports and authorized snapshots. Linked videos stay, as videos of a channel that is not connected.",
  tag: "youtube",
});
youtubeAccountRoutes.delete("/channels/:id", async (c) => {
  const conn = await ownChannel(c, uuidParam(c, "id"));
  await c.get("deps").youtube.disconnect(conn);
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/youtube/channels/:id/uploads",
  summary: "A connected channel's uploads, newest first, 10–50 per page (`pageToken` from `next`).",
  tag: "youtube",
});
youtubeAccountRoutes.get("/channels/:id/uploads", async (c) => {
  const yt = enabledService(c);
  const conn = await ownChannel(c, uuidParam(c, "id"));
  if (!conn.uploadsPlaylistId) return c.json({ items: [], next: null });
  const { pageToken } = query(c, z.object({ pageToken: z.string().max(200).optional() }));
  try {
    return c.json(await yt.client!.uploads(await yt.accessToken(conn), conn.uploadsPlaylistId, pageToken));
  } catch (e) {
    return ytError(e);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Project stats: on the shared router, so MCP tools read the same handlers.

export const youtubeRoutes = new Hono<AppEnv>();

type Counts = { views: number; likes: number | null; comments: number | null };
type Live = Record<string, Counts & { asOf: string; source: "live" | "snapshot" }>;

/**
 * Current counters of a project's videos: read live from the Data API (each with its channel's token when the
 * channel is connected), cached for five minutes; the newest snapshot when a read is not possible.
 */
async function liveCounts(deps: Deps, projectId: string, links: Link[]): Promise<Live> {
  const key = `yt:live:${projectId}:${createHash("sha1")
    .update(links.map((l) => l.videoId).join(","))
    .digest("hex")}`;
  const cached = await deps.redis.get(key);
  if (cached) return JSON.parse(cached) as Live;
  const out: Live = {};
  const groups = new Map<string | null, string[]>();
  for (const l of links) groups.set(l.connectionId, [...(groups.get(l.connectionId) ?? []), l.videoId]);
  let complete = true;
  for (const [connId, ids] of groups) {
    const [conn] = connId ? await deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, connId)) : [];
    const a = deps.youtube.enabled ? await deps.youtube.publicAuth(conn ?? null) : null;
    let vids: YtVideo[] = [];
    if (a)
      try {
        vids = await deps.youtube.videos(ids, a.auth);
      } catch (e) {
        deps.logger.warn("youtube live counts failed", { error: (e as Error).message });
      }
    const now = new Date().toISOString();
    for (const v of vids)
      out[v.id] = { views: v.views, likes: v.likes, comments: v.comments, asOf: now, source: "live" };
    if (vids.length < ids.length) complete = false;
  }
  const missing = links.filter((l) => !out[l.videoId]).map((l) => l.videoId);
  if (missing.length) {
    const snaps = await deps.db.execute<{
      video_id: string;
      views: number;
      likes: number | null;
      comments: number | null;
      taken_at: Date | string;
    }>(sql`
      select distinct on (video_id) video_id, views, likes, comments, taken_at from youtube_snapshots
      where video_id in ${missing} order by video_id, taken_at desc`);
    for (const s of snaps)
      out[s.video_id] = {
        views: Number(s.views),
        likes: s.likes === null ? null : Number(s.likes),
        comments: s.comments === null ? null : Number(s.comments),
        asOf: new Date(s.taken_at).toISOString(),
        source: "snapshot",
      };
  }
  // A partial answer is not cached: the next view tries again.
  if (complete) await deps.redis.set(key, JSON.stringify(out), "EX", LIVE_TTL_S);
  return out;
}

async function projectLinks(deps: Deps, projectId: string) {
  return deps.db
    .select({
      link: youtubeLinks,
      exportFile: exportsTable.fileName,
      connTitle: youtubeChannels.title,
      connStatus: youtubeChannels.status,
    })
    .from(youtubeLinks)
    .leftJoin(exportsTable, eq(exportsTable.id, youtubeLinks.exportId))
    .leftJoin(youtubeChannels, eq(youtubeChannels.id, youtubeLinks.connectionId))
    .where(eq(youtubeLinks.projectId, projectId))
    .orderBy(desc(youtubeLinks.publishedAt), asc(youtubeLinks.createdAt));
}

/** Snapshots of the first 49 hours of each video, as a curve of views per hour since publishing. */
async function curves(deps: Deps, links: Link[]) {
  const withPub = links.filter((l) => l.publishedAt);
  if (!withPub.length) return new Map<string, (number | null)[]>();
  const snaps = await deps.db
    .select({ videoId: youtubeSnapshots.videoId, takenAt: youtubeSnapshots.takenAt, views: youtubeSnapshots.views })
    .from(youtubeSnapshots)
    .where(
      inArray(
        youtubeSnapshots.videoId,
        withPub.map((l) => l.videoId),
      ),
    );
  const out = new Map<string, (number | null)[]>();
  for (const l of withPub) {
    const mine = snaps.filter(
      (s) => s.videoId === l.videoId && s.takenAt.getTime() - l.publishedAt!.getTime() <= 49 * 3600_000,
    );
    if (mine.length) out.set(l.videoId, first48Curve(l.publishedAt!, mine));
  }
  return out;
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/youtube",
  summary:
    "YouTube stats of the project: every linked video with its current counters, totals across videos and channels, film against Shorts, and each video's first-48-hours curve (views per hour since publishing, from hourly snapshots).",
  tag: "youtube",
});
youtubeRoutes.get("/projects/:projectId/youtube", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const deps = c.get("deps");
  const rows = await projectLinks(deps, p.id);
  const links = rows.map((r) => r.link);
  const [live, curveMap, reach] = await Promise.all([
    links.length ? liveCounts(deps, p.id, links) : ({} as Live),
    curves(deps, links),
    links.length
      ? deps.db
          .select({
            videoId: youtubeReach.videoId,
            connectionId: youtubeReach.connectionId,
            impressions: sql<number>`sum(${youtubeReach.impressions})::bigint`.mapWith(Number),
          })
          .from(youtubeReach)
          .where(
            and(
              inArray(
                youtubeReach.videoId,
                links.map((l) => l.videoId),
              ),
              eq(youtubeReach.source, ""),
            ),
          )
          .groupBy(youtubeReach.videoId, youtubeReach.connectionId)
      : [],
  ]);
  const shorts = new Map((p.settings.repurpose?.items ?? []).map((i) => [i.id, i.label || i.title || i.kind]));
  const items = rows.map(({ link: l, exportFile, connTitle, connStatus }) => ({
    id: l.id,
    videoId: l.videoId,
    url:
      l.kind === "short"
        ? `https://www.youtube.com/shorts/${l.videoId}`
        : `https://www.youtube.com/watch?v=${l.videoId}`,
    kind: l.kind,
    title: l.title,
    label: l.label,
    thumbnailUrl: l.thumbnailUrl,
    publishedAt: l.publishedAt,
    durationSeconds: l.durationSeconds,
    channelId: l.channelId,
    channelTitle: l.channelTitle,
    connection: l.connectionId ? { id: l.connectionId, title: connTitle, status: connStatus } : null,
    exportId: l.exportId,
    exportFile,
    shortId: l.shortId,
    shortLabel: l.shortId ? (shorts.get(l.shortId) ?? null) : null,
    counts: live[l.videoId] ?? null,
    impressions: reach.find((r) => r.videoId === l.videoId && r.connectionId === l.connectionId)?.impressions ?? null,
    curve48: curveMap.get(l.videoId) ?? null,
  }));
  const sum = (xs: typeof items) => ({
    videos: xs.length,
    views: xs.reduce((n, x) => n + (x.counts?.views ?? 0), 0),
    likes: xs.reduce((n, x) => n + (x.counts?.likes ?? 0), 0),
    comments: xs.reduce((n, x) => n + (x.counts?.comments ?? 0), 0),
  });
  const channels = new Map<string, typeof items>();
  for (const x of items) {
    const k = x.channelId ?? "unknown";
    channels.set(k, [...(channels.get(k) ?? []), x]);
  }
  return c.json({
    enabled: deps.youtube.enabled,
    links: items,
    totals: {
      all: sum(items),
      film: sum(items.filter((x) => x.kind === "film")),
      short: sum(items.filter((x) => x.kind === "short")),
      byChannel: [...channels].map(([channelId, xs]) => ({ channelId, channelTitle: xs[0]!.channelTitle, ...sum(xs) })),
    },
  });
});

const LinkMeta = z.object({
  kind: z.enum(["film", "short"]).optional(),
  /** An export file of this project the video was rendered from. */
  exportId: z.string().uuid().nullable().optional(),
  /** The repurposing plan's Short (settings.repurpose item id) it came from. */
  shortId: z.string().max(40).nullable().optional(),
  label: z.string().max(120).optional(),
});
const LinkInput = LinkMeta.extend({
  /** A YouTube link in any common form (watch, youtu.be, shorts, live, embed, m./music. hosts, nocookie) or the 11-character id. */
  video: z.string().trim().min(11).max(500),
});

async function checkMeta(deps: Deps, p: Awaited<ReturnType<typeof projectAccess>>, m: z.infer<typeof LinkMeta>) {
  if (m.exportId) {
    const [e] = await deps.db
      .select({ id: exportsTable.id })
      .from(exportsTable)
      .where(and(eq(exportsTable.id, m.exportId), eq(exportsTable.projectId, p.id)));
    if (!e) throw badRequest("exportId is not an export of this project");
  }
  if (m.shortId && !(p.settings.repurpose?.items ?? []).some((i) => i.id === m.shortId))
    throw badRequest("shortId is not an item of this project's repurposing plan");
}

doc({
  method: "POST",
  path: "/api/projects/:projectId/youtube/links",
  summary:
    "Link a published YouTube video to the project by link or id. Its channel's analytics are used when the channel is one you connected; otherwise public counters are snapshotted. `kind` defaults to short for /shorts/ links and videos up to 3 minutes.",
  tag: "youtube",
  body: LinkInput,
});
youtubeRoutes.post("/projects/:projectId/youtube/links", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, LinkInput);
  const deps = c.get("deps");
  const yt = enabledService(c);
  const videoId = parseYouTubeVideoId(input.video);
  if (!videoId) throw badRequest("That is not a YouTube video link or id");
  await checkMeta(deps, p, input);
  const [{ n } = { n: 0 }] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(youtubeLinks)
    .where(eq(youtubeLinks.projectId, p.id));
  if (n >= MAX_LINKS) throw badRequest(`A project links at most ${MAX_LINKS} videos`);
  const [dup] = await deps.db
    .select({ id: youtubeLinks.id })
    .from(youtubeLinks)
    .where(and(eq(youtubeLinks.projectId, p.id), eq(youtubeLinks.videoId, videoId)));
  if (dup) throw conflict("That video is already linked to this project");

  // Read it with the caller's own token when it is on one of their channels, so the counters are authorized data.
  const mine = await deps.db
    .select()
    .from(youtubeChannels)
    .where(and(eq(youtubeChannels.userId, user(c).id), eq(youtubeChannels.status, "active")));
  let video: YtVideo | undefined;
  let conn: YoutubeChannelRow | null = null;
  try {
    const a = await yt.publicAuth(mine[0] ?? null);
    if (!a)
      throw new ApiError(
        422,
        "youtube_no_reader",
        "Connect a YouTube channel first, or ask an administrator to set YOUTUBE_API_KEY, to link videos",
      );
    [video] = await yt.videos([videoId], a.auth);
    conn = mine.find((m) => m.channelId === video?.channelId) ?? null;
    if (video && conn && a.conn?.id !== conn.id)
      [video] = await yt.videos([videoId], { accessToken: await yt.accessToken(conn) });
  } catch (e) {
    ytError(e);
  }
  if (!video) throw notFound("Public or unlisted YouTube video");
  const kind =
    input.kind ?? (isShortsUrl(input.video) || (video.durationSeconds ?? Infinity) <= 180 ? "short" : "film");
  const [link] = await deps.db
    .insert(youtubeLinks)
    .values({
      projectId: p.id,
      videoId,
      channelId: video.channelId,
      channelTitle: video.channelTitle,
      connectionId: conn?.id ?? null,
      kind,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      publishedAt: video.publishedAt ? new Date(video.publishedAt) : null,
      durationSeconds: video.durationSeconds,
      exportId: input.exportId ?? null,
      shortId: input.shortId ?? null,
      label: input.label ?? "",
      createdBy: user(c).id,
    })
    .returning();
  // The first point of its curve, read just now.
  await deps.db.insert(youtubeSnapshots).values({
    videoId,
    views: video.views,
    likes: video.likes,
    comments: video.comments,
    connectionId: conn?.id ?? null,
    authorized: Boolean(conn),
  });
  // A connected video's impressions: read every reach report Google still has (60 days) in the background.
  if (conn)
    await deps.queue
      .enqueue(
        "maintenance",
        "youtube-reports",
        { connectionId: conn.id },
        {
          jobId: `yt-reports-${conn.id}-${Date.now()}`,
          attempts: 2,
        },
      )
      .catch((e) => deps.logger.warn("youtube backfill not queued", { error: (e as Error).message }));
  return c.json({ link }, 201);
});

async function projectLink(c: Context<AppEnv>, action: "read" | "write") {
  const p = await projectAccess(c, uuidParam(c, "projectId"), action);
  const [link] = await c
    .get("deps")
    .db.select()
    .from(youtubeLinks)
    .where(and(eq(youtubeLinks.id, uuidParam(c, "linkId")), eq(youtubeLinks.projectId, p.id)));
  if (!link) throw notFound("Linked video");
  return { p, link };
}

doc({
  method: "PATCH",
  path: "/api/projects/:projectId/youtube/links/:linkId",
  summary: "Change a linked video's kind (film or short), label, or the export or Short it came from.",
  tag: "youtube",
  body: LinkMeta,
});
youtubeRoutes.patch("/projects/:projectId/youtube/links/:linkId", async (c) => {
  const { p, link } = await projectLink(c, "write");
  const input = await body(c, LinkMeta);
  const deps = c.get("deps");
  await checkMeta(deps, p, input);
  const [row] = await deps.db.update(youtubeLinks).set(input).where(eq(youtubeLinks.id, link.id)).returning();
  return c.json({ link: row });
});

doc({
  method: "DELETE",
  path: "/api/projects/:projectId/youtube/links/:linkId",
  summary: "Unlink a video. Stored snapshots and reach rows it alone needed are deleted at the next hourly pass.",
  tag: "youtube",
});
youtubeRoutes.delete("/projects/:projectId/youtube/links/:linkId", async (c) => {
  const { link } = await projectLink(c, "write");
  await c.get("deps").db.delete(youtubeLinks).where(eq(youtubeLinks.id, link.id));
  return c.json({ ok: true });
});

const ANALYTICS_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "likes",
  "comments",
  "shares",
];
const SPLITS = {
  trafficSource: "insightTrafficSourceType",
  country: "country",
  device: "deviceType",
  contentType: "creatorContentType",
} as const;
const isoDay = (t: number) => new Date(t).toISOString().slice(0, 10);
const toObjects = (r: { headers: string[]; rows: (string | number)[][] }) =>
  r.rows.map((row) => Object.fromEntries(r.headers.map((h, i) => [h, row[i]])));

/** Daily history and splits from the Analytics API, queried when a chart opens and cached for 15 minutes only. */
async function analytics(deps: Deps, link: Link) {
  const key = `yt:analytics:${link.id}`;
  const cached = await deps.redis.get(key);
  if (cached) return JSON.parse(cached) as Record<string, unknown>;
  const [conn] = await deps.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, link.connectionId!));
  if (!conn) return null;
  const token = await deps.youtube.accessToken(conn);
  const client = deps.youtube.client!;
  const startDate = isoDay(link.publishedAt?.getTime() ?? Date.now() - 365 * DAY);
  const endDate = isoDay(Date.now() - DAY);
  if (startDate > endDate) return { daily: [], splits: {} };
  const q = { videoId: link.videoId, startDate, endDate };
  const [daily, ...splits] = await Promise.all([
    client.analytics(token, { ...q, dimension: "day", metrics: ANALYTICS_METRICS }),
    ...Object.values(SPLITS).map((dimension) =>
      client.analytics(token, {
        ...q,
        dimension,
        metrics: ["views", "estimatedMinutesWatched"],
      }),
    ),
  ]);
  const out = {
    daily: toObjects(daily!),
    splits: Object.fromEntries(Object.keys(SPLITS).map((k, i) => [k, toObjects(splits[i]!)])),
  };
  await deps.redis.set(key, JSON.stringify(out), "EX", ANALYTICS_TTL_S);
  return out;
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/youtube/links/:linkId/history",
  summary:
    "One linked video's history. On a connected channel: daily Analytics (views, watch time, average view duration and percentage, subscribers gained and lost, likes, comments, shares) since publishing with traffic source, country, device and content-type splits, plus the views since the last Analytics day from the live counter; daily thumbnail impressions and CTR from the reach reports. Otherwise: daily views from the stored snapshots (kept 30 days). Always: the first-48-hours curve.",
  tag: "youtube",
});
youtubeRoutes.get("/projects/:projectId/youtube/links/:linkId/history", async (c) => {
  const { p, link } = await projectLink(c, "read");
  const deps = c.get("deps");
  const live = (await liveCounts(deps, p.id, [link]))[link.videoId] ?? null;
  let a: Record<string, unknown> | null = null;
  let analyticsError: string | null = null;
  if (link.connectionId && deps.youtube.enabled)
    try {
      a = await analytics(deps, link);
    } catch (e) {
      analyticsError = (e as Error).message;
    }

  const snaps = await deps.db
    .select({
      takenAt: youtubeSnapshots.takenAt,
      views: youtubeSnapshots.views,
      likes: youtubeSnapshots.likes,
      comments: youtubeSnapshots.comments,
    })
    .from(youtubeSnapshots)
    .where(eq(youtubeSnapshots.videoId, link.videoId))
    .orderBy(asc(youtubeSnapshots.takenAt));

  let daily: Record<string, unknown>[];
  let source: "analytics" | "snapshots";
  let tail: { after: string; views: number } | null = null;
  if (a) {
    source = "analytics";
    daily = a.daily as Record<string, unknown>[];
    // Analytics trails by two to three days: what the live counter has beyond it.
    const last = daily.at(-1)?.day as string | undefined;
    const counted = daily.reduce((n, d) => n + Number(d.views ?? 0), 0);
    if (last && live) tail = { after: last, views: Math.max(0, live.views - counted) };
  } else {
    source = "snapshots";
    // The last snapshot of each UTC day; a day's views are its rise over the day before.
    const byDay = new Map<string, number>();
    for (const s of snaps) byDay.set(isoDay(s.takenAt.getTime()), s.views);
    if (live) byDay.set(isoDay(Date.parse(live.asOf)), live.views);
    const days = [...byDay].sort((x, y) => x[0].localeCompare(y[0]));
    daily = days.slice(1).map(([day, v], i) => ({ day, views: Math.max(0, v - days[i]![1]), total: v }));
  }
  const since = isoDay(Date.now() - 400 * DAY);
  const reach = link.connectionId
    ? await deps.db
        .select({
          day: youtubeReach.day,
          source: youtubeReach.source,
          impressions: youtubeReach.impressions,
          ctr: youtubeReach.ctr,
        })
        .from(youtubeReach)
        .where(
          and(
            eq(youtubeReach.connectionId, link.connectionId),
            eq(youtubeReach.videoId, link.videoId),
            gte(youtubeReach.day, since),
          ),
        )
        .orderBy(asc(youtubeReach.day))
    : [];
  const bySource = new Map<string, number>();
  for (const r of reach.filter((x) => x.source)) bySource.set(r.source, (bySource.get(r.source) ?? 0) + r.impressions);
  return c.json({
    link: { id: link.id, videoId: link.videoId, title: link.title, kind: link.kind, publishedAt: link.publishedAt },
    live,
    source,
    daily,
    tail,
    splits: a?.splits ?? null,
    analyticsError,
    reach: {
      daily: reach.filter((x) => !x.source).map(({ day, impressions, ctr }) => ({ day, impressions, ctr })),
      bySource: [...bySource].map(([trafficSource, impressions]) => ({ trafficSource, impressions })),
    },
    curve48: link.publishedAt
      ? first48Curve(
          link.publishedAt,
          snaps.filter((s) => s.takenAt.getTime() - link.publishedAt!.getTime() <= 49 * 3600_000),
        )
      : null,
  });
});
