import type { AppConfig, PublicUrlService } from "@openmanga/config";
import {
  and,
  type Database,
  eq,
  isNull,
  lt,
  sql,
  type YoutubeReporting,
  youtubeChannels,
  youtubeLinks,
  youtubeReach,
  youtubeSnapshots,
} from "@openmanga/db";
import { reachRowsFromCsv, snapshotDue, YT_AUTH_RECHECK_MS, YT_UNAUTHORIZED_RETENTION_MS } from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import type { KeyRing } from "./credentials.ts";
import {
  FakeYouTubeClient,
  HttpYouTubeClient,
  REACH_REPORTS,
  type TokenSet,
  type YouTubeClient,
  YouTubeError,
  type YtAuth,
  type YtVideo,
} from "./youtube-client.ts";

export * from "./youtube-client.ts";

export type YoutubeChannelRow = typeof youtubeChannels.$inferSelect;

/** The Google client this instance uses: the fake in AI_MOCK_MODE, Google with an OAuth client, otherwise none. */
export function createYouTubeClient(config: AppConfig, urls: PublicUrlService): YouTubeClient | null {
  if (config.AI_MOCK_MODE) return new FakeYouTubeClient(urls.apiUrl("youtube/fake-consent"));
  if (config.GOOGLE_OAUTH_CLIENT_ID)
    return new HttpYouTubeClient(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);
  return null;
}

/** How often a connection's reach reports are looked for (they arrive once a day). */
const REPORT_CHECK_MS = 12 * 3600_000;

/**
 * YouTube stats on the server: channel tokens, public-counter snapshots, reach-report ingestion and retention.
 * Shared by the API (connect, link, read) and the worker (the hourly `youtube` maintenance job).
 */
export class YouTubeService {
  constructor(
    private readonly db: Database,
    readonly client: YouTubeClient | null,
    private readonly ring: KeyRing,
    private readonly config: Pick<AppConfig, "YOUTUBE_API_KEY">,
    private readonly logger?: Logger,
  ) {}

  get enabled() {
    return this.client !== null;
  }

  private need() {
    if (!this.client) throw new YouTubeError(503, "failed", "YouTube stats are not configured on this server");
    return this.client;
  }

  /**
   * A working access token for a connection, refreshed when it is about to expire. A successful refresh is Google
   * confirming the authorization still stands (`verifiedAt`). A refused one marks the channel revoked and deletes
   * everything stored under it, as the developer policies require when a user withdraws access.
   */
  async accessToken(conn: YoutubeChannelRow): Promise<string> {
    if (conn.status !== "active") throw new YouTubeError(401, "revoked", `Channel "${conn.title}" needs reconnecting`);
    if (
      conn.encryptedAccessToken &&
      conn.accessTokenExpiresAt &&
      conn.accessTokenExpiresAt.getTime() > Date.now() + 60_000
    )
      return this.ring.decrypt(conn.encryptedAccessToken);
    let t: TokenSet;
    try {
      t = await this.need().refresh(this.ring.decrypt(conn.encryptedRefreshToken));
    } catch (e) {
      if (e instanceof YouTubeError && e.code === "revoked") {
        await this.db
          .update(youtubeChannels)
          // The grant is gone at Google: its tokens are useless and are not kept.
          .set({ status: "revoked", encryptedAccessToken: null, encryptedRefreshToken: "" })
          .where(eq(youtubeChannels.id, conn.id));
        await this.purgeStored(conn.id);
        conn.status = "revoked";
        this.logger?.warn("youtube channel authorization revoked", { connectionId: conn.id });
      }
      throw e;
    }
    const patch = {
      encryptedAccessToken: this.ring.encrypt(t.accessToken),
      accessTokenExpiresAt: t.expiresAt,
      verifiedAt: new Date(),
      ...(t.refreshToken ? { encryptedRefreshToken: this.ring.encrypt(t.refreshToken) } : {}),
    };
    await this.db.update(youtubeChannels).set(patch).where(eq(youtubeChannels.id, conn.id));
    Object.assign(conn, patch);
    return t.accessToken;
  }

  /** Stores a channel the user just granted (a reconnect replaces its tokens) and sets up its reach reports. */
  async connect(userId: string, t: TokenSet) {
    if (!t.refreshToken)
      throw new YouTubeError(400, "failed", "Google did not return a refresh token; try connecting again");
    const ch = await this.need().myChannel(t.accessToken);
    const values = {
      userId,
      channelId: ch.id,
      title: ch.title,
      thumbnailUrl: ch.thumbnailUrl,
      uploadsPlaylistId: ch.uploadsPlaylistId,
      encryptedRefreshToken: this.ring.encrypt(t.refreshToken),
      encryptedAccessToken: this.ring.encrypt(t.accessToken),
      accessTokenExpiresAt: t.expiresAt,
      scopes: t.scopes,
      status: "active" as const,
      verifiedAt: new Date(),
    };
    const [conn] = await this.db
      .insert(youtubeChannels)
      .values(values)
      .onConflictDoUpdate({ target: [youtubeChannels.userId, youtubeChannels.channelId], set: values })
      .returning();
    // Videos of this channel the user linked before connecting it now get its analytics.
    await this.db
      .update(youtubeLinks)
      .set({ connectionId: conn!.id })
      .where(
        and(
          eq(youtubeLinks.channelId, ch.id),
          eq(youtubeLinks.createdBy, userId),
          isNull(youtubeLinks.connectionId),
          // Only in projects they still belong to: a project they left does not get their grant back.
          sql`${youtubeLinks.projectId} in (select project_id from project_members where user_id = ${userId})`,
        ),
      );
    await this.setupReporting(conn!);
    return conn!;
  }

  /**
   * Creates the reach reporting jobs (or finds the ones the channel already has). Reports exist only from the
   * moment a job is created (plus a 30-day backfill), so this runs as soon as a channel connects. A failure (the
   * Reporting API not enabled on the Cloud project) is kept on the channel and retried with each report check.
   */
  async setupReporting(conn: YoutubeChannelRow) {
    const reporting: YoutubeReporting = { ...conn.reporting };
    let error: string | null = null;
    try {
      const token = await this.accessToken(conn);
      for (const [kind, type] of Object.entries(REACH_REPORTS) as [keyof typeof REACH_REPORTS, string][])
        if (!reporting[kind])
          reporting[kind] = { jobId: await this.need().ensureReportingJob(token, type), fetchedThrough: null };
    } catch (e) {
      error = (e as Error).message;
    }
    await this.db
      .update(youtubeChannels)
      .set({ reporting, reportingError: error })
      .where(eq(youtubeChannels.id, conn.id));
    conn.reporting = reporting;
    conn.reportingError = error;
  }

  /**
   * Downloads new reach reports and keeps the rows of videos linked under this connection (impressions and CTR).
   * `full` starts over from the oldest report Google still has (60 days), for a video linked just now.
   */
  async ingestReports(conn: YoutubeChannelRow, o: { full?: boolean } = {}) {
    if (!conn.reporting.basic || !conn.reporting.combined) await this.setupReporting(conn);
    const token = await this.accessToken(conn);
    const linked = new Set(
      (
        await this.db
          .selectDistinct({ v: youtubeLinks.videoId })
          .from(youtubeLinks)
          .where(eq(youtubeLinks.connectionId, conn.id))
      ).map((r) => r.v),
    );
    const reporting: YoutubeReporting = { ...conn.reporting };
    let rows = 0;
    for (const kind of ["basic", "combined"] as const) {
      const job = reporting[kind];
      if (!job) continue;
      const reports = await this.need().listReports(token, job.jobId, o.full ? null : job.fetchedThrough);
      for (const r of reports) {
        const keep = linked.size
          ? reachRowsFromCsv(await this.need().downloadReport(token, r.downloadUrl), kind).filter((x) =>
              linked.has(x.videoId),
            )
          : [];
        for (let i = 0; i < keep.length; i += 500) {
          const chunk = keep.slice(i, i + 500).map((x) => ({ connectionId: conn.id, ...x }));
          await this.db
            .insert(youtubeReach)
            .values(chunk)
            .onConflictDoUpdate({
              target: [youtubeReach.connectionId, youtubeReach.videoId, youtubeReach.day, youtubeReach.source],
              set: { impressions: sql`excluded.impressions`, ctr: sql`excluded.ctr` },
            });
        }
        rows += keep.length;
        if (!job.fetchedThrough || r.createTime > job.fetchedThrough) job.fetchedThrough = r.createTime;
      }
    }
    reporting.checkedAt = new Date().toISOString();
    await this.db
      .update(youtubeChannels)
      .set({ reporting, reportingError: null })
      .where(eq(youtubeChannels.id, conn.id));
    conn.reporting = reporting;
    return rows;
  }

  /** Revokes the grant at Google and deletes the channel with everything stored under it. */
  async disconnect(conn: YoutubeChannelRow) {
    // Revoking is what the policy requires, so a failure (Google unreachable) keeps the row for a retry instead of
    // forgetting a grant that would stay live. An already revoked or expired token counts as done (the client
    // treats Google's 400 as success); a connection whose grant was refused has no token left to revoke.
    if (conn.encryptedRefreshToken) await this.client?.revoke(this.ring.decrypt(conn.encryptedRefreshToken));
    await this.db.delete(youtubeChannels).where(eq(youtubeChannels.id, conn.id));
  }

  /** Reach rows and owner-authorized snapshots of a connection. */
  private async purgeStored(connectionId: string) {
    await this.db.delete(youtubeReach).where(eq(youtubeReach.connectionId, connectionId));
    await this.db.delete(youtubeSnapshots).where(eq(youtubeSnapshots.connectionId, connectionId));
  }

  /**
   * Credentials for reading public counters: the given channel's token (the link's own connection, or the caller's
   * channel), else the instance's API key. Never another user's grant: it would read on their behalf, and the Data
   * API shows a channel's own private videos to its token. Null when neither is there.
   */
  async publicAuth(
    prefer?: YoutubeChannelRow | null,
  ): Promise<{ auth: YtAuth; conn: YoutubeChannelRow | null } | null> {
    if (prefer?.status === "active")
      try {
        return { auth: { accessToken: await this.accessToken(prefer) }, conn: prefer };
      } catch {}
    if (this.config.YOUTUBE_API_KEY) return { auth: { apiKey: this.config.YOUTUBE_API_KEY }, conn: null };
    if (this.client?.fake) return { auth: { apiKey: "fake" }, conn: null };
    return null;
  }

  /** Videos with their live counters, 50 per call. */
  async videos(ids: string[], auth: YtAuth): Promise<YtVideo[]> {
    const out: YtVideo[] = [];
    for (let i = 0; i < ids.length; i += 50) out.push(...(await this.need().videos(ids.slice(i, i + 50), auth)));
    return out;
  }

  /**
   * Snapshots the public counters of every linked video that is due one (see `snapshotDue`), reading each with its
   * channel's token when that channel is connected (stored as Authorized Data) and otherwise with the API key.
   */
  async takeSnapshots(now = new Date()) {
    const rows = await this.db.execute<{
      video_id: string;
      published_at: Date | string | null;
      conn_id: string | null;
      last: Date | string | null;
    }>(sql`
      select l.video_id, min(l.published_at) as published_at,
        (array_agg(c.id) filter (where c.status = 'active'))[1] as conn_id,
        (select max(s.taken_at) from youtube_snapshots s where s.video_id = l.video_id) as last
      from youtube_links l left join youtube_channels c on c.id = l.connection_id
      group by l.video_id`);
    const d = (v: Date | string | null) => (v ? new Date(v) : null);
    const due = [...rows].filter((r) =>
      snapshotDue({ publishedAt: d(r.published_at), connected: Boolean(r.conn_id), lastSnapshotAt: d(r.last) }, now),
    );
    const groups = new Map<string | null, string[]>();
    for (const r of due) groups.set(r.conn_id, [...(groups.get(r.conn_id) ?? []), r.video_id]);
    let taken = 0;
    for (const [connId, ids] of groups) {
      const [conn] = connId ? await this.db.select().from(youtubeChannels).where(eq(youtubeChannels.id, connId)) : [];
      const a = await this.publicAuth(conn ?? null);
      if (!a) {
        this.logger?.warn("youtube snapshots skipped: no API key or connected channel", { videos: ids.length });
        continue;
      }
      let vids: YtVideo[];
      try {
        vids = await this.videos(ids, a.auth);
      } catch (e) {
        this.logger?.warn("youtube snapshot read failed", { error: (e as Error).message });
        continue;
      }
      if (!vids.length) continue;
      await this.db.insert(youtubeSnapshots).values(
        vids.map((v) => {
          const authorized = Boolean(a.conn && v.channelId === a.conn.channelId);
          return {
            videoId: v.id,
            takenAt: now,
            views: v.views,
            likes: v.likes,
            comments: v.comments,
            connectionId: authorized ? a.conn!.id : null,
            authorized,
          };
        }),
      );
      // Keep what is shown consistent with YouTube: titles and thumbnails change.
      for (const v of vids)
        await this.db
          .update(youtubeLinks)
          .set({ title: v.title, thumbnailUrl: v.thumbnailUrl, channelTitle: v.channelTitle })
          .where(eq(youtubeLinks.videoId, v.id));
      taken += vids.length;
    }
    return taken;
  }

  /**
   * Retention under the YouTube API Services Developer Policies (docs/SECURITY.md#youtube-data):
   * - statistics read without the owner's authorization: at most 30 days;
   * - anything stored for a video no project links any more: deleted (no longer needed);
   * - reach rows of a video no longer linked under that connection: deleted;
   * - Authorized Data of a connection whose authorization was not re-confirmed for 30 days: deleted.
   */
  async retention(now = new Date()) {
    const r: Record<string, number> = {};
    r.expiredUnauthorized = (
      await this.db
        .delete(youtubeSnapshots)
        .where(
          and(
            isNull(youtubeSnapshots.connectionId),
            lt(youtubeSnapshots.takenAt, new Date(now.getTime() - YT_UNAUTHORIZED_RETENTION_MS)),
          ),
        )
        .returning({ id: youtubeSnapshots.id })
    ).length;
    r.unlinkedSnapshots = (
      await this.db
        .delete(youtubeSnapshots)
        .where(sql`not exists (select 1 from youtube_links l where l.video_id = ${youtubeSnapshots.videoId})`)
        .returning({ id: youtubeSnapshots.id })
    ).length;
    r.unlinkedReach = (
      await this.db.execute(sql`
        delete from youtube_reach r where not exists (
          select 1 from youtube_links l where l.connection_id = r.connection_id and l.video_id = r.video_id)`)
    ).count;
    const stale = await this.db
      .select({ id: youtubeChannels.id })
      .from(youtubeChannels)
      .where(lt(youtubeChannels.verifiedAt, new Date(now.getTime() - YT_AUTH_RECHECK_MS)));
    for (const c of stale) await this.purgeStored(c.id);
    r.unverifiedChannels = stale.length;
    return r;
  }

  /** The hourly worker pass: due snapshots, reach reports twice a day per channel, then retention. */
  async hourly(now = new Date()) {
    const result: Record<string, number> = { snapshots: 0, reachRows: 0, reportErrors: 0 };
    if (!this.enabled) return { ...result, ...(await this.retention(now)) };
    result.snapshots = await this.takeSnapshots(now);
    const conns = await this.db.select().from(youtubeChannels).where(eq(youtubeChannels.status, "active"));
    for (const c of conns) {
      const checked = c.reporting.checkedAt ? Date.parse(c.reporting.checkedAt) : 0;
      if (now.getTime() - checked < REPORT_CHECK_MS) continue;
      try {
        result.reachRows! += await this.ingestReports(c);
      } catch (e) {
        result.reportErrors!++;
        await this.db
          .update(youtubeChannels)
          .set({ reportingError: (e as Error).message })
          .where(eq(youtubeChannels.id, c.id));
        this.logger?.warn("youtube reach reports failed", { connectionId: c.id, error: (e as Error).message });
      }
    }
    return { ...result, ...(await this.retention(now)) };
  }
}
