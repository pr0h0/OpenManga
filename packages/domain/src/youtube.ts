/**
 * YouTube stats: pure rules shared by the API, the worker and the web app. Google calls live in
 * `@openmanga/services` (`youtube.ts`); everything here is deterministic and testable without them.
 */

const ID = /^[A-Za-z0-9_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);

/**
 * The 11-character video id in a link or a bare id: `watch?v=`, `youtu.be/`, `/shorts/`, `/live/`, `/embed/` (also
 * `/v/`), on the `www.`, `m.` and `music.` hosts and `youtube-nocookie.com`. Other parameters (`t`, `list`, `si`, …)
 * are ignored. Null for anything else, including a playlist or channel link.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const s = input.trim();
  if (ID.test(s)) return s;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (!HOSTS.has(host)) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const id = host.endsWith("youtu.be")
    ? parts[0]
    : parts[0] === "watch"
      ? u.searchParams.get("v")
      : ["shorts", "live", "embed", "v"].includes(parts[0] ?? "")
        ? parts[1]
        : null;
  return id && ID.test(id) ? id : null;
}

/** Whether a link reads as a Short: a `/shorts/` URL. */
export const isShortsUrl = (input: string) => /\/shorts\/[A-Za-z0-9_-]{11}/.test(input);

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** Hourly snapshots cover a video's first 48 hours: the first-48-hours curve. */
export const YT_HOURLY_WINDOW_MS = 48 * HOUR;
/**
 * YouTube API Services Developer Policies III.E.4: statistics read without the channel owner's authorization
 * (an API key, or another channel's token) may be stored for at most 30 days.
 */
export const YT_UNAUTHORIZED_RETENTION_MS = 30 * DAY;
/** Same section: stored Authorized Data may be kept only while authorization is re-confirmed at least every 30 days. */
export const YT_AUTH_RECHECK_MS = 30 * DAY;

/**
 * Whether a linked video is due a public-counter snapshot: hourly in its first 48 hours (every linked video, for
 * the curve), then daily only for videos on channels that are not connected, which have nothing else. A connected
 * video's later history comes from the Analytics API instead.
 */
export function snapshotDue(
  v: { publishedAt: Date | null; connected: boolean; lastSnapshotAt: Date | null },
  now: Date,
): boolean {
  const since = v.lastSnapshotAt ? now.getTime() - v.lastSnapshotAt.getTime() : Number.POSITIVE_INFINITY;
  // A few minutes' slack so an hourly scheduler that fires a little early still counts.
  const slack = 5 * 60_000;
  const age = v.publishedAt ? now.getTime() - v.publishedAt.getTime() : Number.POSITIVE_INFINITY;
  if (age < YT_HOURLY_WINDOW_MS + HOUR) return since >= HOUR - slack;
  if (v.connected) return false;
  return since >= DAY - slack;
}

/** Whether a stored snapshot must go (see the constants above): unauthorized ones after 30 days. */
export function snapshotExpired(s: { takenAt: Date; authorized: boolean }, now: Date) {
  return !s.authorized && now.getTime() - s.takenAt.getTime() > YT_UNAUTHORIZED_RETENTION_MS;
}

export type CountPoint = { t: number; views: number; likes: number; comments: number };

/**
 * Views at each whole hour 0..48 after publishing, interpolated linearly between snapshots. Hours before the first
 * snapshot or after the last one are null: the curve shows what was measured, nothing extrapolated. Hour 0 is 0
 * views by definition.
 */
export function first48Curve(publishedAt: Date, snaps: { takenAt: Date; views: number }[]): (number | null)[] {
  const pts = [
    { h: 0, v: 0 },
    ...snaps
      .map((s) => ({ h: (s.takenAt.getTime() - publishedAt.getTime()) / HOUR, v: s.views }))
      .filter((p) => p.h > 0 && p.h <= 49)
      .sort((a, b) => a.h - b.h),
  ];
  if (pts.length < 2) return Array.from({ length: 49 }, (_, h) => (h === 0 ? 0 : null));
  const out: (number | null)[] = [];
  for (let h = 0; h <= 48; h++) {
    const j = pts.findIndex((p) => p.h >= h);
    if (j < 0) out.push(null);
    else if (j === 0 || pts[j]!.h === h) out.push(pts[j]!.v);
    else {
      const a = pts[j - 1]!;
      const b = pts[j]!;
      out.push(Math.round(a.v + ((b.v - a.v) * (h - a.h)) / (b.h - a.h)));
    }
  }
  return out;
}

/** A minimal RFC 4180 CSV reader (quoted fields, doubled quotes, CRLF), enough for Reporting API reports. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.length > 1 || row[0]) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** One stored reach row: a video's thumbnail impressions on a day, overall (`source` "") or for one traffic source. */
export type ReachRow = { videoId: string; day: string; source: string; impressions: number; ctr: number | null };

/**
 * The rows the app keeps from a reach report: `channel_reach_basic_a1` as it comes (impressions and CTR per video
 * and day), `channel_reach_combined_a1` reduced to impressions per traffic source (its other dimensions, operating
 * system and device, are summed away; its CTR is not kept, the basic report has it). `day` is YYYY-MM-DD.
 */
export function reachRowsFromCsv(text: string, kind: "basic" | "combined"): ReachRow[] {
  const [head, ...body] = parseCsv(text);
  if (!head) return [];
  const col = (n: string) => head.indexOf(n);
  const [d, v, imp, ctr, src] = [
    col("date"),
    col("video_id"),
    col("video_thumbnail_impressions"),
    col("video_thumbnail_impressions_ctr"),
    col("traffic_source_type"),
  ];
  if (d < 0 || v < 0 || imp < 0) throw new Error("Reach report is missing date, video_id or impressions");
  const out = new Map<string, ReachRow>();
  for (const r of body) {
    const raw = r[d] ?? "";
    const day = /^\d{8}$/.test(raw) ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}` : raw;
    const videoId = r[v] ?? "";
    if (!videoId || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const source = kind === "combined" ? (r[src] ?? "") || "unknown" : "";
    const key = `${videoId}|${day}|${source}`;
    const impressions = Number(r[imp]) || 0;
    const prev = out.get(key);
    if (prev) prev.impressions += impressions;
    else
      out.set(key, {
        videoId,
        day,
        source,
        impressions,
        ctr: kind === "basic" && ctr >= 0 && r[ctr] !== "" ? Number(r[ctr]) : null,
      });
  }
  return [...out.values()];
}

/** ISO 8601 duration (PT1H2M3S) in seconds. */
export function isoDurationSeconds(d: string | null | undefined): number | null {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}
