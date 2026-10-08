import { createHash } from "node:crypto";
import { isoDurationSeconds } from "@openmanga/domain";

/**
 * Every Google call YouTube stats make, behind one interface: `HttpYouTubeClient` talks to Google with fetch, and
 * `FakeYouTubeClient` (AI_MOCK_MODE and tests) answers deterministically, consent screen included, so the feature
 * runs end to end without a Google Cloud project.
 */
export interface YouTubeClient {
  readonly fake: boolean;
  /** Google's consent screen (the fake's own page in mock mode). */
  authUrl(o: { state: string; redirectUri: string; codeChallenge: string }): string;
  exchangeCode(o: { code: string; redirectUri: string; codeVerifier: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  /** The channel the token was granted for. */
  myChannel(accessToken: string): Promise<YtChannel>;
  uploads(
    accessToken: string,
    playlistId: string,
    pageToken?: string,
  ): Promise<{ items: YtUpload[]; next: string | null }>;
  /** Up to 50 videos per call (one quota unit), with an access token or the instance's API key. */
  videos(ids: string[], auth: YtAuth): Promise<YtVideo[]>;
  /** One YouTube Analytics API query about one video, `ids=channel==MINE`. */
  analytics(accessToken: string, q: AnalyticsQuery): Promise<{ headers: string[]; rows: (string | number)[][] }>;
  /** The Reporting API job for a report type, created if the channel has none yet. */
  ensureReportingJob(accessToken: string, reportTypeId: string): Promise<string>;
  /** Reports of a job created after `createdAfter` (RFC 3339), oldest first. */
  listReports(accessToken: string, jobId: string, createdAfter: string | null): Promise<YtReport[]>;
  downloadReport(accessToken: string, url: string): Promise<string>;
}

export type TokenSet = { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] };
export type YtAuth = { accessToken: string } | { apiKey: string };
export type YtChannel = { id: string; title: string; thumbnailUrl: string | null; uploadsPlaylistId: string | null };
export type YtUpload = { videoId: string; title: string; publishedAt: string | null; thumbnailUrl: string | null };
export type YtVideo = {
  id: string;
  channelId: string;
  channelTitle: string;
  title: string;
  publishedAt: string | null;
  thumbnailUrl: string | null;
  durationSeconds: number | null;
  views: number;
  likes: number | null;
  comments: number | null;
};
export type AnalyticsQuery = {
  videoId: string;
  startDate: string;
  endDate: string;
  metrics: string[];
  dimension: "day" | "insightTrafficSourceType" | "country" | "deviceType" | "creatorContentType";
};
export type YtReport = { id: string; startTime: string; createTime: string; downloadUrl: string };

export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];
export const REACH_REPORTS = { basic: "channel_reach_basic_a1", combined: "channel_reach_combined_a1" } as const;

/** A Google refusal. `revoked`: the refresh token no longer works; `quota`: the daily quota is spent. */
export class YouTubeError extends Error {
  constructor(
    readonly status: number,
    readonly code: "revoked" | "quota" | "not_enabled" | "not_found" | "failed",
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA = "https://www.googleapis.com/youtube/v3";

export class HttpYouTubeClient implements YouTubeClient {
  readonly fake = false;
  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  authUrl(o: { state: string; redirectUri: string; codeChallenge: string }) {
    const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    for (const [k, v] of Object.entries({
      client_id: this.clientId,
      redirect_uri: o.redirectUri,
      response_type: "code",
      scope: YOUTUBE_SCOPES.join(" "),
      access_type: "offline",
      // Always ask: a refresh token is only issued with consent, and the channel (brand account) is picked there.
      prompt: "consent select_account",
      include_granted_scopes: "true",
      state: o.state,
      code_challenge: o.codeChallenge,
      code_challenge_method: "S256",
    }))
      u.searchParams.set(k, v);
    return u.toString();
  }

  private async call<T>(url: string, init: RequestInit & { what: string }): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new YouTubeError(0, "failed", `${init.what}: ${(e as Error).message}`);
    }
    const text = await res.text();
    if (res.ok)
      return (init.method === "POST" && !text ? {} : url.includes("alt=media") ? text : JSON.parse(text)) as T;
    let reason = "";
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as {
        error?: string | { message?: string; errors?: { reason?: string }[]; status?: string };
        error_description?: string;
      };
      if (typeof j.error === "string") {
        reason = j.error;
        message = j.error_description ?? j.error;
      } else if (j.error) {
        reason = j.error.errors?.[0]?.reason ?? j.error.status ?? "";
        message = j.error.message ?? message;
      }
    } catch {}
    const code =
      reason === "invalid_grant"
        ? "revoked"
        : /quota/i.test(reason)
          ? "quota"
          : /accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(message)
            ? "not_enabled"
            : res.status === 404
              ? "not_found"
              : "failed";
    throw new YouTubeError(res.status, code, `${init.what}: ${message}`);
  }

  private token(params: Record<string, string>, what: string) {
    return this.call<{ access_token: string; refresh_token?: string; expires_in: number; scope?: string }>(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, ...params }),
      what,
    }).then((t) => ({
      accessToken: t.access_token,
      refreshToken: t.refresh_token ?? null,
      expiresAt: new Date(Date.now() + t.expires_in * 1000),
      scopes: (t.scope ?? "").split(" ").filter(Boolean),
    }));
  }

  exchangeCode(o: { code: string; redirectUri: string; codeVerifier: string }) {
    return this.token(
      { grant_type: "authorization_code", code: o.code, redirect_uri: o.redirectUri, code_verifier: o.codeVerifier },
      "Google sign-in",
    );
  }
  refresh(refreshToken: string) {
    return this.token({ grant_type: "refresh_token", refresh_token: refreshToken }, "Google token refresh");
  }
  async revoke(token: string) {
    await this.call(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      what: "Google token revoke",
    }).catch((e) => {
      // Already revoked or expired is the outcome we wanted.
      if (!(e instanceof YouTubeError && e.status === 400)) throw e;
    });
  }

  private get<T>(url: string, auth: YtAuth, what: string) {
    const u = new URL(url);
    if ("apiKey" in auth) u.searchParams.set("key", auth.apiKey);
    return this.call<T>(u.toString(), {
      headers: "accessToken" in auth ? { authorization: `Bearer ${auth.accessToken}` } : {},
      what,
    });
  }

  async myChannel(accessToken: string) {
    type R = {
      items?: {
        id: string;
        snippet: { title: string; thumbnails?: Record<string, { url: string }> };
        contentDetails?: { relatedPlaylists?: { uploads?: string } };
      }[];
    };
    const r = await this.get<R>(
      `${DATA}/channels?part=snippet,contentDetails&mine=true`,
      { accessToken },
      "YouTube channel",
    );
    const c = r.items?.[0];
    if (!c) throw new YouTubeError(404, "not_found", "This Google account has no YouTube channel");
    return {
      id: c.id,
      title: c.snippet.title,
      thumbnailUrl: c.snippet.thumbnails?.default?.url ?? null,
      uploadsPlaylistId: c.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
  }

  async uploads(accessToken: string, playlistId: string, pageToken?: string) {
    type R = {
      nextPageToken?: string;
      items?: {
        snippet: { title: string; thumbnails?: Record<string, { url: string }> };
        contentDetails: { videoId: string; videoPublishedAt?: string };
      }[];
    };
    const u = new URL(`${DATA}/playlistItems`);
    u.search = new URLSearchParams({ part: "snippet,contentDetails", playlistId, maxResults: "50" }).toString();
    if (pageToken) u.searchParams.set("pageToken", pageToken);
    const r = await this.get<R>(u.toString(), { accessToken }, "YouTube uploads");
    return {
      items: (r.items ?? []).map((i) => ({
        videoId: i.contentDetails.videoId,
        title: i.snippet.title,
        publishedAt: i.contentDetails.videoPublishedAt ?? null,
        thumbnailUrl: i.snippet.thumbnails?.medium?.url ?? i.snippet.thumbnails?.default?.url ?? null,
      })),
      next: r.nextPageToken ?? null,
    };
  }

  async videos(ids: string[], auth: YtAuth) {
    if (!ids.length) return [];
    if (ids.length > 50) throw new Error("videos.list takes at most 50 ids");
    type R = {
      items?: {
        id: string;
        snippet: {
          channelId: string;
          channelTitle: string;
          title: string;
          publishedAt?: string;
          thumbnails?: Record<string, { url: string }>;
        };
        contentDetails?: { duration?: string };
        statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
      }[];
    };
    const r = await this.get<R>(
      `${DATA}/videos?part=snippet,statistics,contentDetails&id=${ids.map(encodeURIComponent).join(",")}`,
      auth,
      "YouTube videos",
    );
    const n = (s?: string) => (s === undefined ? null : Number(s));
    return (r.items ?? []).map((v) => ({
      id: v.id,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      title: v.snippet.title,
      publishedAt: v.snippet.publishedAt ?? null,
      thumbnailUrl: v.snippet.thumbnails?.medium?.url ?? v.snippet.thumbnails?.default?.url ?? null,
      durationSeconds: isoDurationSeconds(v.contentDetails?.duration),
      views: n(v.statistics?.viewCount) ?? 0,
      likes: n(v.statistics?.likeCount),
      comments: n(v.statistics?.commentCount),
    }));
  }

  async analytics(accessToken: string, q: AnalyticsQuery) {
    const u = new URL("https://youtubeanalytics.googleapis.com/v2/reports");
    u.search = new URLSearchParams({
      ids: "channel==MINE",
      startDate: q.startDate,
      endDate: q.endDate,
      metrics: q.metrics.join(","),
      dimensions: q.dimension,
      filters: `video==${q.videoId}`,
      ...(q.dimension === "day" ? { sort: "day" } : { sort: `-${q.metrics[0]}`, maxResults: "25" }),
    }).toString();
    const r = await this.get<{ columnHeaders?: { name: string }[]; rows?: (string | number)[][] }>(
      u.toString(),
      { accessToken },
      "YouTube Analytics",
    );
    return { headers: (r.columnHeaders ?? []).map((h) => h.name), rows: r.rows ?? [] };
  }

  async ensureReportingJob(accessToken: string, reportTypeId: string) {
    const auth = { accessToken };
    type Jobs = { jobs?: { id: string; reportTypeId: string }[] };
    const have = await this.get<Jobs>(
      "https://youtubereporting.googleapis.com/v1/jobs",
      auth,
      "YouTube Reporting jobs",
    );
    const found = have.jobs?.find((j) => j.reportTypeId === reportTypeId);
    if (found) return found.id;
    const job = await this.call<{ id: string }>("https://youtubereporting.googleapis.com/v1/jobs", {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
      body: JSON.stringify({ reportTypeId, name: `OpenManga ${reportTypeId}` }),
      what: "YouTube Reporting job",
    });
    return job.id;
  }

  async listReports(accessToken: string, jobId: string, createdAfter: string | null) {
    const out: YtReport[] = [];
    let pageToken = "";
    do {
      const u = new URL(`https://youtubereporting.googleapis.com/v1/jobs/${encodeURIComponent(jobId)}/reports`);
      if (createdAfter) u.searchParams.set("createdAfter", createdAfter);
      if (pageToken) u.searchParams.set("pageToken", pageToken);
      const r = await this.get<{ reports?: YtReport[]; nextPageToken?: string }>(
        u.toString(),
        { accessToken },
        "YouTube Reporting reports",
      );
      out.push(...(r.reports ?? []));
      pageToken = r.nextPageToken ?? "";
    } while (pageToken);
    return out.sort((a, b) => a.createTime.localeCompare(b.createTime));
  }

  async downloadReport(accessToken: string, url: string) {
    // The bearer token only ever goes to Google's own report host, whatever a listing says.
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "youtubereporting.googleapis.com")
      throw new YouTubeError(400, "failed", `Unexpected report download host ${u.hostname}`);
    if (!u.searchParams.has("alt")) u.searchParams.set("alt", "media");
    return this.call<string>(u.toString(), {
      headers: { authorization: `Bearer ${accessToken}` },
      what: "YouTube report",
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The fake: stateless and deterministic, so the API and worker processes agree without sharing anything.

const h = (s: string) => createHash("sha256").update(s).digest();
const hnum = (s: string) => h(s).readUInt32BE(0);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const b64 = (s: string, n: number) => [...h(s).subarray(0, n)].map((b) => ALPHABET[b % 64]).join("");
const DAY = 86400_000;
const HOUR = 3600_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Fake Google. A consent "code" is `fake.<name>`, the channel is named after it. Video ids are an 8-character channel
 * prefix plus a 3-digit index, so any id maps back to a channel; ids from elsewhere (a real link pasted in mock
 * mode) belong to an unconnected "Other channel". A fake channel's newest upload is always 24 to 48 hours old, so
 * the first-48-hours curve has something to show.
 */
export class FakeYouTubeClient implements YouTubeClient {
  readonly fake = true;
  constructor(
    private readonly consentUrl: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  authUrl(o: { state: string; redirectUri: string; codeChallenge: string }) {
    const u = new URL(this.consentUrl);
    u.searchParams.set("state", o.state);
    u.searchParams.set("redirect_uri", o.redirectUri);
    return u.toString();
  }

  private tokens(name: string): TokenSet {
    return {
      accessToken: `fake-access.${name}.${this.now().getTime()}`,
      refreshToken: `fake-refresh.${name}`,
      expiresAt: new Date(this.now().getTime() + HOUR),
      scopes: YOUTUBE_SCOPES,
    };
  }
  async exchangeCode(o: { code: string }) {
    const m = /^fake\.([\w .-]{1,60})$/.exec(o.code);
    if (!m) throw new YouTubeError(400, "failed", "Google sign-in: invalid_grant");
    return this.tokens(m[1]!);
  }
  async refresh(refreshToken: string) {
    const m = /^fake-refresh\.(.+)$/.exec(refreshToken);
    // A channel named "revoked…" behaves like an authorization the user withdrew in their Google account.
    if (!m || m[1]!.startsWith("revoked"))
      throw new YouTubeError(400, "revoked", "Google token refresh: invalid_grant");
    return { ...this.tokens(m[1]!), refreshToken: null };
  }
  async revoke() {}

  private nameOf(accessToken: string) {
    const m = /^fake-access\.(.+)\.\d+$/.exec(accessToken);
    if (!m) throw new YouTubeError(401, "failed", "Invalid fake access token");
    return m[1]!;
  }
  static prefix = (name: string) => b64(`channel:${name}`, 8);
  private static channelId = (prefix: string) => `UC${b64(`cid:${prefix}`, 22)}`;

  async myChannel(accessToken: string) {
    const name = this.nameOf(accessToken);
    const p = FakeYouTubeClient.prefix(name);
    return { id: FakeYouTubeClient.channelId(p), title: name, thumbnailUrl: null, uploadsPlaylistId: `UU${p}` };
  }

  private publishedAt(id: string) {
    const idx = /^[\w-]{8}(\d{3})$/.exec(id);
    if (!idx) return new Date(Date.UTC(2026, 0, 1) + (hnum(id) % 200) * DAY);
    // Index 000 is published at the start of yesterday (UTC): between 24 and 48 hours old, so it is in its first two
    // days and Analytics already has one full day of it, whatever the time. Older ones every three days before it.
    const anchor = Math.floor(this.now().getTime() / DAY) * DAY - DAY;
    return new Date(anchor - Number(idx[1]) * 3 * DAY);
  }
  private isShort = (id: string) => /\d{3}$/.test(id) && Number(id.slice(-3)) % 3 === 2;
  /** Cumulative views `ms` after publishing: a fast start that flattens out. */
  private viewsAt(id: string, ms: number) {
    if (ms <= 0) return 0;
    const k = 2000 + (hnum(id) % 50_000);
    return Math.round(k * (1 - Math.exp(-ms / (3 * DAY))) + (k / 30) * (ms / DAY));
  }

  async uploads(accessToken: string, playlistId: string, pageToken?: string) {
    const name = this.nameOf(accessToken);
    const p = FakeYouTubeClient.prefix(name);
    if (playlistId !== `UU${p}`) throw new YouTubeError(404, "not_found", "YouTube uploads: playlist not found");
    const start = Number(pageToken ?? 0);
    const items = Array.from({ length: Math.min(10, 14 - start) }, (_, i) => {
      const id = `${p}${String(start + i).padStart(3, "0")}`;
      return {
        videoId: id,
        title: `${name} ${this.isShort(id) ? "Short" : "Episode"} ${14 - start - i}`,
        publishedAt: this.publishedAt(id).toISOString(),
        thumbnailUrl: null,
      };
    });
    return { items, next: start + 10 < 14 ? String(start + 10) : null };
  }

  async videos(ids: string[], _auth: YtAuth) {
    const now = this.now().getTime();
    return ids.map((id) => {
      const known = /^[\w-]{8}\d{3}$/.test(id);
      const pub = this.publishedAt(id);
      const views = this.viewsAt(id, now - pub.getTime());
      return {
        id,
        channelId: known ? FakeYouTubeClient.channelId(id.slice(0, 8)) : "UCother-fake-channel000",
        channelTitle: known ? `Channel ${id.slice(0, 8)}` : "Other channel",
        title: known ? `Video ${id}` : `Pasted video ${id}`,
        publishedAt: pub.toISOString(),
        thumbnailUrl: null,
        durationSeconds: this.isShort(id) ? 45 : 600 + (hnum(id) % 1200),
        views,
        likes: Math.round(views / 25),
        comments: Math.round(views / 200),
      };
    });
  }

  async analytics(accessToken: string, q: AnalyticsQuery) {
    this.nameOf(accessToken);
    const pub = this.publishedAt(q.videoId).getTime();
    const val = (metric: string, views: number, salt: string) => {
      switch (metric) {
        case "views":
          return views;
        case "estimatedMinutesWatched":
          return Math.round(views * 2.5);
        case "averageViewDuration":
          return 90 + (hnum(salt) % 120);
        case "averageViewPercentage":
          return 30 + (hnum(salt) % 50);
        case "subscribersGained":
          return Math.round(views / 120);
        case "subscribersLost":
          return Math.round(views / 900);
        case "likes":
          return Math.round(views / 25);
        case "comments":
          return Math.round(views / 200);
        case "shares":
          return Math.round(views / 150);
        default:
          return 0;
      }
    };
    if (q.dimension === "day") {
      const rows: (string | number)[][] = [];
      const firstDay = Math.max(Date.parse(q.startDate), Math.floor(pub / DAY) * DAY);
      for (let d = firstDay; d <= Date.parse(q.endDate); d += DAY) {
        const views = this.viewsAt(q.videoId, d + DAY - pub) - this.viewsAt(q.videoId, d - pub);
        rows.push([iso(new Date(d)), ...q.metrics.map((m) => val(m, views, `${q.videoId}${d}`))]);
      }
      return { headers: ["day", ...q.metrics], rows };
    }
    const keys = {
      insightTrafficSourceType: ["YT_SEARCH", "SUBSCRIBER", "RELATED_VIDEO", "SHORTS", "EXT_URL"],
      country: ["US", "GB", "DE", "IN", "BR"],
      deviceType: ["MOBILE", "DESKTOP", "TV", "TABLET"],
      creatorContentType: this.isShort(q.videoId) ? ["SHORTS"] : ["VIDEO_ON_DEMAND"],
    }[q.dimension];
    const total = this.viewsAt(q.videoId, Date.parse(q.endDate) + DAY - pub);
    const weights = keys.map((k) => 1 + (hnum(`${q.videoId}${k}`) % 9));
    const sum = weights.reduce((a, b) => a + b, 0);
    return {
      headers: [q.dimension, ...q.metrics],
      rows: keys.map((k, i) => [k, ...q.metrics.map((m) => val(m, Math.round((total * weights[i]!) / sum), k))]),
    };
  }

  async ensureReportingJob(accessToken: string, reportTypeId: string) {
    return `fake-job.${reportTypeId}.${FakeYouTubeClient.prefix(this.nameOf(accessToken))}`;
  }

  /** One report a day for the last 30 days (the backfill), each created three days after the day it covers. */
  async listReports(accessToken: string, jobId: string, createdAfter: string | null) {
    this.nameOf(accessToken);
    const today = Math.floor(this.now().getTime() / DAY) * DAY;
    const out: YtReport[] = [];
    for (let d = today - 33 * DAY; d <= today - 3 * DAY; d += DAY) {
      const createTime = new Date(d + 3 * DAY).toISOString();
      if (createdAfter && createTime <= createdAfter) continue;
      out.push({
        id: `${jobId}.${iso(new Date(d))}`,
        startTime: new Date(d).toISOString(),
        createTime,
        downloadUrl: `fake://report/${jobId}/${iso(new Date(d))}`,
      });
    }
    return out;
  }

  async downloadReport(accessToken: string, url: string) {
    this.nameOf(accessToken);
    const m = /^fake:\/\/report\/fake-job\.(\w+)\.([\w-]{8})\/(\d{4}-\d{2}-\d{2})$/.exec(url);
    if (!m) throw new YouTubeError(404, "not_found", "Unknown fake report");
    const [, type, prefix, day] = m;
    const combined = type === REACH_REPORTS.combined;
    const dayMs = Date.parse(day!);
    const lines = [
      combined
        ? "date,channel_id,video_id,traffic_source_type,traffic_source_detail,operating_system,device_type,video_thumbnail_impressions,video_thumbnail_impressions_ctr"
        : "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr",
    ];
    const cid = FakeYouTubeClient.channelId(prefix!);
    for (let i = 0; i < 14; i++) {
      const id = `${prefix}${String(i).padStart(3, "0")}`;
      if (this.publishedAt(id).getTime() > dayMs) continue;
      const views =
        this.viewsAt(id, dayMs + DAY - this.publishedAt(id).getTime()) -
        this.viewsAt(id, dayMs - this.publishedAt(id).getTime());
      const impressions = views * 12 + (hnum(`${id}${day}`) % 500);
      const ctr = (2 + (hnum(`ctr${id}${day}`) % 80) / 10) / 100;
      const date = day!.replaceAll("-", "");
      if (!combined) lines.push(`${date},${cid},${id},${impressions},${ctr.toFixed(4)}`);
      else
        for (const [src, share] of [
          ["5", 0.5],
          ["7", 0.3],
          ["3", 0.2],
        ] as const)
          for (const device of ["1", "2"])
            lines.push(
              `${date},${cid},${id},${src},,1,${device},${Math.round((impressions * share) / 2)},${ctr.toFixed(4)}`,
            );
    }
    return `${lines.join("\n")}\n`;
  }
}
