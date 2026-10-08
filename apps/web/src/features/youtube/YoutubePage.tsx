import { useQuery } from "@tanstack/react-query";
import { BarChart3, ExternalLink, Link2, Pencil, Plus, Trash2, TrendingUp, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import type { ExportListItem } from "../../api/types.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  Modal,
  PageHeader,
  Spinner,
  Tabs,
  toast,
} from "../../components/ui.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";
import { BarChart, LineChart, ShareBars, seriesColor } from "./charts.tsx";

type Channel = {
  id: string;
  title: string;
  status: "active" | "revoked";
  reportingReady: boolean;
  reportingError: string | null;
  reportsCheckedAt: string | null;
};
type ChannelList = { enabled: boolean; mock: boolean; apiKey: boolean; channels: Channel[] };
type Counts = {
  views: number;
  likes: number | null;
  comments: number | null;
  asOf: string;
  source: "live" | "snapshot";
};
type LinkItem = {
  id: string;
  videoId: string;
  url: string;
  kind: "film" | "short";
  title: string;
  label: string;
  thumbnailUrl: string | null;
  publishedAt: string | null;
  channelTitle: string | null;
  connection: { id: string; title: string | null; status: string | null } | null;
  exportId: string | null;
  exportFile: string | null;
  shortId: string | null;
  shortLabel: string | null;
  counts: Counts | null;
  impressions: number | null;
  curve48: (number | null)[] | null;
};
type Sum = { videos: number; views: number; likes: number; comments: number };
type Summary = {
  enabled: boolean;
  links: LinkItem[];
  totals: { all: Sum; film: Sum; short: Sum; byChannel: (Sum & { channelId: string; channelTitle: string | null })[] };
};
type Upload = { videoId: string; title: string; publishedAt: string | null };
type History = {
  source: "analytics" | "snapshots";
  daily: Record<string, number | string>[];
  tail: { after: string; views: number } | null;
  splits: Record<string, Record<string, number | string>[]> | null;
  analyticsError: string | null;
  live: Counts | null;
  reach: {
    daily: { day: string; impressions: number; ctr: number | null }[];
    bySource: { trafficSource: string; impressions: number }[];
  };
};

const channelsKey = ["youtube", "channels"] as const;
const summaryKey = (projectId: string) => ["project", projectId, "youtube"] as const;

/** Shows the outcome of Google's redirect back (?youtube_connected / ?youtube_error) once, then drops it from the URL. */
function useConnectOutcome() {
  useEffect(() => {
    const u = new URL(window.location.href);
    const ok = u.searchParams.get("youtube_connected");
    const err = u.searchParams.get("youtube_error");
    if (ok) toast.success(`Connected ${ok}`);
    if (err) toast.error(new Error(err));
    if (ok || err) {
      u.searchParams.delete("youtube_connected");
      u.searchParams.delete("youtube_error");
      window.history.replaceState(null, "", u.toString());
    }
  }, []);
}

/** Connected YouTube channels: each its own read-only OAuth connection. */
export function YoutubeChannels({ returnTo }: { returnTo: string }) {
  useConnectOutcome();
  const q = useQuery({ queryKey: channelsKey, queryFn: () => get<ChannelList>("/youtube/channels") });
  const [removing, setRemoving] = useState<Channel | null>(null);
  const connect = useAction(() => post<{ url: string }>("/youtube/connect", { returnTo }), {
    onSuccess: (r) => window.location.assign(r.url),
  });
  const remove = useAction((id: string) => del(`/youtube/channels/${id}`), {
    invalidate: [channelsKey, ["project"]],
    success: "Channel disconnected",
    onSuccess: () => setRemoving(null),
  });
  const d = q.data;
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-medium">YouTube channels</h2>
        {d?.enabled && (
          <button type="button" className="btn-secondary" onClick={() => connect.mutate()} disabled={connect.isPending}>
            {connect.isPending ? <Spinner /> : <Plus className="size-4" />} Connect a channel
          </button>
        )}
      </div>
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {d && !d.enabled && (
        <p className="muted text-sm">
          YouTube stats are not set up on this server. An administrator registers a Google Cloud OAuth client and sets
          GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET (see the deployment guide).
        </p>
      )}
      {d?.enabled && (
        <p className="muted text-xs">
          Read-only access to views, analytics and reach. A Google account that manages several brand channels connects
          each one separately.{d.mock && " Mock mode: channels connect through a fake Google consent screen."}
        </p>
      )}
      {d?.channels.length === 0 && d.enabled && <p className="muted text-sm">No channel connected yet.</p>}
      <ul className="divide-y divide-[var(--border)] text-sm">
        {d?.channels.map((c) => (
          <li key={c.id} className="flex items-center gap-2 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{c.title}</div>
              {c.status === "revoked" ? (
                <div className="text-xs text-red-700 dark:text-red-300">
                  Access was withdrawn in the Google account: connect it again, or disconnect.
                </div>
              ) : c.reportingError ? (
                <div className="text-xs text-amber-800 [overflow-wrap:anywhere] dark:text-amber-300">
                  Reach reports unavailable: {c.reportingError}
                </div>
              ) : (
                <div className="muted text-xs">
                  {c.reportingReady
                    ? `Reach reports ${c.reportsCheckedAt ? `checked ${fmt.ago(c.reportsCheckedAt)}` : "set up"}`
                    : ""}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setRemoving(c)}
              aria-label={`Disconnect ${c.title}`}
            >
              <Unplug className="size-4" /> Disconnect
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={Boolean(removing)}
        title={`Disconnect ${removing?.title ?? ""}?`}
        confirmLabel="Disconnect"
        danger
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing.id)}
        onClose={() => setRemoving(null)}
      >
        Access is revoked at Google, and the reach reports and authorized snapshots stored for this channel are deleted.
        Linked videos stay, with public counters only.
      </ConfirmDialog>
    </section>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="card p-4">
      <div className="muted text-xs">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint && <div className="muted text-xs">{hint}</div>}
    </div>
  );
}

const sumHint = (s: Sum) => `${s.videos} video${s.videos === 1 ? "" : "s"} · ${fmt.num(s.likes)} likes`;

/** Where a video came from: an export file of the project, or a Short of its repurposing plan. */
function SourcePicker({
  value,
  onChange,
}: {
  value: { exportId: string | null; shortId: string | null };
  onChange: (v: { exportId: string | null; shortId: string | null }) => void;
}) {
  const projectId = useProjectId();
  const project = useProject();
  const exports = useQuery({
    queryKey: ["project", projectId, "exports"],
    queryFn: () => get<{ jobs: ExportListItem[] }>(`/projects/${projectId}/exports`),
  });
  const files = (exports.data?.jobs ?? []).flatMap((j) => j.files.filter((f) => /video|youtube/.test(f.kind)));
  const shorts =
    (
      project.data?.project.settings as {
        repurpose?: { items?: { id: string; kind: string; label: string; title: string }[] };
      }
    )?.repurpose?.items ?? [];
  const current = value.exportId ? `e:${value.exportId}` : value.shortId ? `s:${value.shortId}` : "";
  return (
    <Field label="Came from" hint="The export file or the Short of the repurposing plan it was made from.">
      <select
        className="input"
        value={current}
        onChange={(e) => {
          const v = e.target.value;
          onChange({
            exportId: v.startsWith("e:") ? v.slice(2) : null,
            shortId: v.startsWith("s:") ? v.slice(2) : null,
          });
        }}
      >
        <option value="">Not recorded</option>
        {shorts.length > 0 && (
          <optgroup label="Repurposing plan">
            {shorts.map((s) => (
              <option key={s.id} value={`s:${s.id}`}>
                {s.label || s.title || s.kind}
              </option>
            ))}
          </optgroup>
        )}
        {files.length > 0 && (
          <optgroup label="Export files">
            {files.map((f) => (
              <option key={f.id} value={`e:${f.id}`}>
                {f.fileName}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </Field>
  );
}

function AddVideo({ open, onClose, linked }: { open: boolean; onClose: () => void; linked: Set<string> }) {
  const projectId = useProjectId();
  const [tab, setTab] = useState<"paste" | "uploads">("paste");
  const [video, setVideo] = useState("");
  const [kind, setKind] = useState<"" | "film" | "short">("");
  const [label, setLabel] = useState("");
  const [source, setSource] = useState<{ exportId: string | null; shortId: string | null }>({
    exportId: null,
    shortId: null,
  });
  const channels = useQuery({
    queryKey: channelsKey,
    queryFn: () => get<ChannelList>("/youtube/channels"),
    enabled: open,
  });
  const active = channels.data?.channels.filter((c) => c.status === "active") ?? [];
  const [channelId, setChannelId] = useState("");
  const chosen = channelId || active[0]?.id || "";
  const [pages, setPages] = useState<string[]>([""]);
  const uploads = useQuery({
    queryKey: ["youtube", "uploads", chosen, pages],
    queryFn: async () => {
      const all: Upload[] = [];
      let next: string | null = null;
      for (const token of pages) {
        const r: { items: Upload[]; next: string | null } = await get(
          `/youtube/channels/${chosen}/uploads${token ? `?pageToken=${encodeURIComponent(token)}` : ""}`,
        );
        all.push(...r.items);
        next = r.next;
      }
      return { items: all, next };
    },
    enabled: open && tab === "uploads" && Boolean(chosen),
  });
  const add = useAction(
    (v: string) =>
      post(`/projects/${projectId}/youtube/links`, {
        video: v,
        ...(kind ? { kind } : {}),
        label: label.trim(),
        ...source,
      }),
    {
      invalidate: [summaryKey(projectId)],
      success: "Video linked",
      onSuccess: () => {
        setVideo("");
        setLabel("");
        if (tab === "paste") onClose();
      },
    },
  );
  return (
    <Modal open={open} onClose={onClose} title="Link a YouTube video">
      <div className="space-y-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "paste", label: "Paste a link" },
            { value: "uploads", label: "From my channel" },
          ]}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Kind" hint="Detect: a /shorts/ link or a video up to 3 minutes is a Short.">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="">Detect</option>
              <option value="film">Film</option>
              <option value="short">Short</option>
            </select>
          </Field>
          <Field label="Label (optional)">
            <input
              className="input"
              value={label}
              maxLength={120}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. German dub"
            />
          </Field>
        </div>
        <SourcePicker value={source} onChange={setSource} />
        {tab === "paste" ? (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              add.mutate(video);
            }}
          >
            <Field
              label="Video link or id"
              hint="watch?v=, youtu.be, /shorts/, /live/, /embed/ links or the 11-character id."
            >
              <input
                className="input"
                value={video}
                onChange={(e) => setVideo(e.target.value)}
                placeholder="https://youtu.be/…"
                required
                autoFocus
              />
            </Field>
            <button type="submit" className="btn-primary" disabled={add.isPending || !video.trim()}>
              {add.isPending ? <Spinner /> : <Link2 className="size-4" />} Link video
            </button>
          </form>
        ) : active.length === 0 ? (
          <p className="muted text-sm">Connect a channel first (Account → YouTube channels, or below on this page).</p>
        ) : (
          <div className="space-y-2">
            {active.length > 1 && (
              <select
                className="input"
                aria-label="Channel"
                value={chosen}
                onChange={(e) => {
                  setChannelId(e.target.value);
                  setPages([""]);
                }}
              >
                {active.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            )}
            {uploads.error && <ErrorBox error={uploads.error} />}
            <ul className="max-h-80 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] text-sm">
              {uploads.data?.items.map((u) => (
                <li key={u.videoId} className="flex items-center gap-2 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate">{u.title}</div>
                    <div className="muted text-xs">
                      {u.publishedAt ? new Date(u.publishedAt).toLocaleDateString() : ""}
                    </div>
                  </div>
                  {linked.has(u.videoId) ? (
                    <span className="muted text-xs">Linked</span>
                  ) : (
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={add.isPending}
                      onClick={() => add.mutate(u.videoId)}
                    >
                      Link
                    </button>
                  )}
                </li>
              ))}
              {uploads.isLoading && (
                <li className="p-3">
                  <Spinner />
                </li>
              )}
            </ul>
            {uploads.data?.next && (
              <button type="button" className="btn-ghost" onClick={() => setPages([...pages, uploads.data!.next!])}>
                Load more
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function EditLink({ link, onClose }: { link: LinkItem; onClose: () => void }) {
  const projectId = useProjectId();
  const [kind, setKind] = useState(link.kind);
  const [label, setLabel] = useState(link.label);
  const [source, setSource] = useState({ exportId: link.exportId, shortId: link.shortId });
  const save = useAction(() => patch(`/projects/${projectId}/youtube/links/${link.id}`, { kind, label, ...source }), {
    invalidate: [summaryKey(projectId)],
    success: "Saved",
    onSuccess: onClose,
  });
  return (
    <Modal open onClose={onClose} title={link.title || link.videoId}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value as LinkItem["kind"])}>
            <option value="film">Film</option>
            <option value="short">Short</option>
          </select>
        </Field>
        <Field label="Label">
          <input className="input" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <SourcePicker value={source} onChange={setSource} />
        <button type="submit" className="btn-primary" disabled={save.isPending}>
          {save.isPending && <Spinner />} Save
        </button>
      </form>
    </Modal>
  );
}

const METRICS: [string, string][] = [
  ["views", "Views"],
  ["estimatedMinutesWatched", "Watch time (minutes)"],
  ["averageViewDuration", "Average view duration (s)"],
  ["averageViewPercentage", "Average percentage viewed"],
  ["subscribersGained", "Subscribers gained"],
  ["subscribersLost", "Subscribers lost"],
  ["likes", "Likes"],
  ["comments", "Comments"],
  ["shares", "Shares"],
];
const SPLIT_LABELS: Record<string, string> = {
  trafficSource: "Traffic sources",
  country: "Countries",
  device: "Devices",
  contentType: "Shorts or long form",
};
/** Reporting API traffic source codes, and the Analytics API's names made readable. */
const TRAFFIC: Record<string, string> = {
  "0": "Direct or unknown",
  "1": "YouTube advertising",
  "3": "Browse features",
  "4": "Channel pages",
  "5": "YouTube search",
  "7": "Suggested videos",
  "8": "Other YouTube features",
  "9": "External",
  "11": "Cards and annotations",
  "14": "Playlists",
  "17": "Notifications",
  "18": "Playlist pages",
  "20": "End screens",
  "23": "Stories",
  "24": "Shorts feed",
  "26": "Hashtag pages",
  "27": "Sound pages",
  "28": "Live redirect",
  "30": "Remixed video",
  "31": "Vertical live feed",
  "32": "Related video",
  TV: "TV",
};
const readable = (k: string) =>
  TRAFFIC[k] ??
  k
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^\w/, (c) => c.toUpperCase());
const dayLabel = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

/** One video's history: opened on demand, so the Analytics API is only asked when someone looks. */
function VideoHistory({ link }: { link: LinkItem }) {
  const projectId = useProjectId();
  const [metric, setMetric] = useState("views");
  const q = useQuery({
    queryKey: ["project", projectId, "youtube", link.id, "history"],
    queryFn: () => get<History>(`/projects/${projectId}/youtube/links/${link.id}/history`),
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data!;
  const analytics = h.source === "analytics";
  const m = analytics ? metric : "views";
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="muted text-xs">
          {analytics
            ? "Daily, from YouTube Analytics (two to three days behind)."
            : "Daily views from the stored public counters (kept 30 days for channels that are not connected)."}
          {h.analyticsError && ` Analytics unavailable: ${h.analyticsError}`}
        </div>
        {analytics && (
          <select
            className="input w-auto"
            aria-label="Metric"
            value={metric}
            onChange={(e) => setMetric(e.target.value)}
          >
            {METRICS.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        )}
      </div>
      {h.daily.length ? (
        <BarChart
          label={`${METRICS.find((x) => x[0] === m)?.[1]} per day`}
          points={h.daily.map((d) => ({ label: dayLabel(String(d.day)), value: Number(d[m] ?? 0) }))}
        />
      ) : (
        <p className="muted text-sm">No daily history yet.</p>
      )}
      {h.tail && h.tail.views > 0 && (
        <p className="text-sm">
          <TrendingUp className="mr-1 inline size-4" />
          {fmt.num(h.tail.views)} more views since {dayLabel(h.tail.after)}, from the live counter.
        </p>
      )}
      {h.reach.daily.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-1 text-sm font-medium">Thumbnail impressions per day</h4>
            <BarChart
              label="Thumbnail impressions per day"
              points={h.reach.daily.map((d) => ({ label: dayLabel(d.day), value: d.impressions }))}
            />
          </div>
          <div>
            <h4 className="mb-1 text-sm font-medium">Click-through rate per day</h4>
            <LineChart
              label="Thumbnail click-through rate per day"
              series={[{ name: "CTR", values: h.reach.daily.map((d) => (d.ctr === null ? null : d.ctr * 100)) }]}
              xLabel={(i) => dayLabel(h.reach.daily[i]!.day)}
              fmt={(n) => `${n.toFixed(1)}%`}
            />
          </div>
        </div>
      )}
      {(h.splits || h.reach.bySource.length > 0) && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Object.entries(h.splits ?? {}).map(([k, rows]) => (
            <div key={k}>
              <h4 className="mb-1 text-sm font-medium">{SPLIT_LABELS[k] ?? k} (views)</h4>
              <ShareBars
                rows={rows.map((r) => ({
                  key: k === "country" ? String(Object.values(r)[0]) : readable(String(Object.values(r)[0])),
                  value: Number(r.views ?? 0),
                }))}
              />
            </div>
          ))}
          {h.reach.bySource.length > 0 && (
            <div>
              <h4 className="mb-1 text-sm font-medium">Impressions by traffic source</h4>
              <ShareBars
                rows={h.reach.bySource.map((r) => ({ key: readable(r.trafficSource), value: r.impressions }))}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function YoutubePage() {
  const projectId = useProjectId();
  const project = useProject();
  const canWrite = project.data?.role !== "viewer";
  const q = useQuery({
    queryKey: summaryKey(projectId),
    queryFn: () => get<Summary>(`/projects/${projectId}/youtube`),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<LinkItem | null>(null);
  const [unlinking, setUnlinking] = useState<LinkItem | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const unlink = useAction((id: string) => del(`/projects/${projectId}/youtube/links/${id}`), {
    invalidate: [summaryKey(projectId)],
    success: "Video unlinked",
    onSuccess: () => setUnlinking(null),
  });
  const s = q.data;
  // Up to eight curves, newest first: a ninth colour would be a guess.
  const curves = (s?.links ?? []).filter((l) => l.curve48).slice(0, 8);
  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <PageHeader
        title="YouTube stats"
        subtitle="How this project's published film and Shorts do, across every channel they are on."
        actions={
          canWrite &&
          s?.enabled && (
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Link a video
            </button>
          )
        }
      />
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading && <Spinner />}
      {s && !s.links.length && (
        <EmptyState icon={<BarChart3 className="size-8" />} title="No videos linked yet">
          {s.enabled
            ? "Link the film and Shorts you published, from a connected channel's uploads or by pasting a link."
            : "YouTube stats are not set up on this server."}
        </EmptyState>
      )}
      {s && s.links.length > 0 && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Views, all videos" value={fmt.num(s.totals.all.views)} hint={sumHint(s.totals.all)} />
            <Stat label="Film" value={fmt.num(s.totals.film.views)} hint={sumHint(s.totals.film)} />
            <Stat label="Shorts" value={fmt.num(s.totals.short.views)} hint={sumHint(s.totals.short)} />
            <Stat
              label="Comments"
              value={fmt.num(s.totals.all.comments)}
              hint={`${s.totals.byChannel.length} channel(s)`}
            />
          </div>
          {s.totals.byChannel.length > 1 && (
            <section className="card overflow-x-auto p-4">
              <h2 className="mb-2 font-medium">By channel</h2>
              <table className="w-full text-sm">
                <thead className="muted text-xs">
                  <tr>
                    <th className="p-2 text-left font-normal">Channel</th>
                    <th className="p-2 text-right font-normal">Videos</th>
                    <th className="p-2 text-right font-normal">Views</th>
                    <th className="p-2 text-right font-normal">Likes</th>
                  </tr>
                </thead>
                <tbody>
                  {s.totals.byChannel.map((c) => (
                    <tr key={c.channelId} className="border-t border-[var(--border)]">
                      <td className="p-2">{c.channelTitle ?? c.channelId}</td>
                      <td className="p-2 text-right tabular-nums">{c.videos}</td>
                      <td className="p-2 text-right tabular-nums">{fmt.num(c.views)}</td>
                      <td className="p-2 text-right tabular-nums">{fmt.num(c.likes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {curves.length > 0 && (
            <section className="card p-4">
              <h2 className="font-medium">First 48 hours</h2>
              <p className="muted mb-2 text-xs">
                Views by hour since publishing, from hourly snapshots of the public counter; gaps were not measured.
              </p>
              <LineChart
                label="Views in the first 48 hours of each release"
                series={curves.map((l) => ({ name: l.label || l.title || l.videoId, values: l.curve48! }))}
                xLabel={(i) => `${i} h`}
              />
            </section>
          )}
          <section className="card divide-y divide-[var(--border)]">
            {s.links.map((l) => (
              <div key={l.id} className="p-3 sm:p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="flex min-w-0 items-center gap-2">
                        {curves.includes(l) && (
                          <span
                            className="size-2.5 shrink-0 rounded-full"
                            style={{ background: seriesColor(curves.indexOf(l)) }}
                          />
                        )}
                        <a
                          href={l.url}
                          target="_blank"
                          rel="noreferrer"
                          className="min-w-0 truncate font-medium hover:underline"
                        >
                          {l.title || l.videoId}
                        </a>
                      </span>
                      <span className="chip">{l.kind === "short" ? "Short" : "Film"}</span>
                      {l.label && <span className="chip">{l.label}</span>}
                    </div>
                    <div className="muted mt-0.5 text-xs [overflow-wrap:anywhere]">
                      {l.channelTitle ?? "Unknown channel"}
                      {l.connection ? " · connected" : " · public counters"}
                      {l.publishedAt && ` · published ${fmt.date(l.publishedAt)}`}
                      {(l.shortLabel || l.exportFile) && ` · from ${l.shortLabel ?? l.exportFile}`}
                    </div>
                  </div>
                  <div className="flex gap-4 text-right text-sm tabular-nums">
                    <div>
                      <div className="font-semibold">{l.counts ? fmt.num(l.counts.views) : "—"}</div>
                      <div className="muted text-xs">views</div>
                    </div>
                    <div>
                      <div>{fmt.num(l.counts?.likes)}</div>
                      <div className="muted text-xs">likes</div>
                    </div>
                    {l.impressions !== null && (
                      <div>
                        <div>{fmt.num(l.impressions)}</div>
                        <div className="muted text-xs">impressions</div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-expanded={open === l.id}
                    onClick={() => setOpen(open === l.id ? null : l.id)}
                  >
                    <BarChart3 className="size-4" /> {open === l.id ? "Hide chart" : "Chart"}
                  </button>
                  <a className="btn-ghost" href={l.url} target="_blank" rel="noreferrer">
                    <ExternalLink className="size-4" /> YouTube
                  </a>
                  {canWrite && (
                    <>
                      <button type="button" className="btn-ghost" onClick={() => setEditing(l)}>
                        <Pencil className="size-4" /> Edit
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setUnlinking(l)}>
                        <Trash2 className="size-4" /> Unlink
                      </button>
                    </>
                  )}
                </div>
                {open === l.id && (
                  <div className="mt-3">
                    <VideoHistory link={l} />
                  </div>
                )}
              </div>
            ))}
          </section>
          <p className="muted text-xs">
            Counters are live (re-read at most every five minutes). Stored data follows YouTube's developer policies:
            public counters of channels that are not connected are kept 30 days.
          </p>
        </>
      )}
      {canWrite && s?.enabled && <YoutubeChannels returnTo={`/projects/${projectId}/youtube`} />}
      <AddVideo open={adding} onClose={() => setAdding(false)} linked={new Set(s?.links.map((l) => l.videoId))} />
      {editing && <EditLink link={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(unlinking)}
        title="Unlink this video?"
        confirmLabel="Unlink"
        danger
        busy={unlink.isPending}
        onConfirm={() => unlinking && unlink.mutate(unlinking.id)}
        onClose={() => setUnlinking(null)}
      >
        Its stats stop showing here. Nothing changes on YouTube.
      </ConfirmDialog>
    </div>
  );
}
