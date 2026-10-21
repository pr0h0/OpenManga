import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { del, get, patch } from "../../api/client.ts";
import { qk, useAction, useMe } from "../../api/hooks.ts";
import { ConfirmDialog, ErrorBox, Spinner, toast } from "../../components/ui.tsx";

type PageRow = { route: string; visits: number; ms: number; days: number; users?: number };
type ActionRow = {
  action: string;
  source: string;
  count: number;
  errors: number;
  ms: number;
  days: number;
  users?: number;
};
type Stats = { since: string | null; enabled?: boolean; users?: number; pages: PageRow[]; actions: ActionRow[] };

const RANGES = [
  { days: 7, label: "Last 7 days" },
  { days: 30, label: "Last 30 days" },
  { days: 90, label: "Last 90 days" },
  { days: 0, label: "All time" },
];
const SHOWN = 20;

function dur(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function download(name: string, type: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

function toCsv(s: Stats, titleOf: (r: string) => string | undefined) {
  const head = ["kind", "key", "title", "source", "count", "errors", "total_ms", "avg_ms", "days", "users"];
  const rows = [
    ...s.pages.map((p) => ["page", p.route, titleOf(p.route), "web", p.visits, 0, p.ms, "", p.days, p.users]),
    ...s.actions.map((a) => [
      "action",
      a.action,
      "",
      a.source,
      a.count,
      a.errors,
      a.ms,
      a.count ? Math.round(a.ms / a.count) : 0,
      a.days,
      a.users,
    ]),
  ];
  return [head, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

/** Tables, range and export over one stats endpoint: the user's own, or the instance totals for an admin. */
function ActivityView({ path, scope }: { path: string; scope: "user" | "instance" }) {
  const [days, setDays] = useState(30);
  const [all, setAll] = useState(false);
  const router = useRouter();
  const q = useQuery({
    queryKey: ["activity", path, days],
    queryFn: () => get<Stats>(`${path}${days ? `?days=${days}` : ""}`),
  });
  const byPath = router.routesByPath as Record<string, { options?: { staticData?: { title?: string } } } | undefined>;
  const titleOf = (r: string) => (byPath[r] ?? byPath[r.replace(/\/$/, "")])?.options?.staticData?.title;
  const s = q.data;
  const exportAs = (format: "json" | "csv") => {
    if (!s) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const name = `openmanga-activity-${scope}-${stamp}.${format}`;
    if (format === "csv") return download(name, "text/csv", toCsv(s, titleOf));
    const body = {
      app: "OpenManga",
      kind: "activity",
      scope,
      exportedAt: new Date().toISOString(),
      since: s.since,
      ...(scope === "instance" ? { users: s.users } : {}),
      pages: s.pages.map((p) => ({ ...p, title: titleOf(p.route) })),
      actions: s.actions,
    };
    download(name, "application/json", JSON.stringify(body, null, 2));
  };
  const instance = scope === "instance";
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          aria-label="Range"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          {RANGES.map((r) => (
            <option key={r.days} value={r.days}>
              {r.label}
            </option>
          ))}
        </select>
        {instance && s && (
          <span className="muted text-xs">
            {s.users} {s.users === 1 ? "person" : "people"} with stats
          </span>
        )}
        <span className="mr-auto" />
        <button type="button" className="btn-secondary" disabled={!s} onClick={() => exportAs("csv")}>
          Export CSV
        </button>
        <button type="button" className="btn-secondary" disabled={!s} onClick={() => exportAs("json")}>
          Export JSON
        </button>
      </div>
      {q.isLoading && <Spinner />}
      {q.error && <ErrorBox error={q.error} />}
      {s && !s.pages.length && !s.actions.length && (
        <p className="muted text-sm">Nothing recorded in this range yet.</p>
      )}
      {s && s.pages.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="mb-1 text-left font-medium">Screens by time spent</caption>
            <thead className="muted text-left text-xs">
              <tr>
                <th className="py-1 pr-2 font-normal">Screen</th>
                <th className="px-2 text-right font-normal">Visits</th>
                <th className="px-2 text-right font-normal">Time</th>
                {instance && <th className="pl-2 text-right font-normal">Users</th>}
              </tr>
            </thead>
            <tbody>
              {(all ? s.pages : s.pages.slice(0, SHOWN)).map((p) => (
                <tr key={p.route} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2">
                    {titleOf(p.route) ?? p.route}
                    {titleOf(p.route) && <span className="muted ml-2 break-all font-mono text-xs">{p.route}</span>}
                  </td>
                  <td className="px-2 text-right tabular-nums">{p.visits}</td>
                  <td className="px-2 text-right tabular-nums">{dur(p.ms)}</td>
                  {instance && <td className="pl-2 text-right tabular-nums">{p.users}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s && s.actions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="mb-1 text-left font-medium">Actions by use</caption>
            <thead className="muted text-left text-xs">
              <tr>
                <th className="py-1 pr-2 font-normal">Action</th>
                <th className="px-2 font-normal">By</th>
                <th className="px-2 text-right font-normal">Uses</th>
                <th className="px-2 text-right font-normal">Failed</th>
                <th className="px-2 text-right font-normal">Avg time</th>
                {instance && <th className="pl-2 text-right font-normal">Users</th>}
              </tr>
            </thead>
            <tbody>
              {(all ? s.actions : s.actions.slice(0, SHOWN)).map((a) => (
                <tr key={`${a.action} ${a.source}`} className="border-t border-[var(--border)]">
                  <td className="break-all py-1 pr-2 font-mono text-xs">{a.action}</td>
                  <td className="px-2 text-xs">
                    {a.source === "web" ? (instance ? "Web" : "You") : a.source === "agent" ? "Agent" : "Run"}
                  </td>
                  <td className="px-2 text-right tabular-nums">{a.count}</td>
                  <td className="px-2 text-right tabular-nums">{a.errors || ""}</td>
                  <td className="px-2 text-right tabular-nums">{a.count ? `${Math.round(a.ms / a.count)} ms` : ""}</td>
                  {instance && <td className="pl-2 text-right tabular-nums">{a.users}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s && (s.pages.length > SHOWN || s.actions.length > SHOWN) && (
        <button type="button" className="btn-ghost text-xs" onClick={() => setAll(!all)}>
          {all ? "Show top 20" : "Show all"}
        </button>
      )}
    </div>
  );
}

/** Account: your own stats, the switch, and clearing them. */
export function MyActivity() {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const on = me?.settings?.activityTracking !== false;
  const toggle = useAction((activityTracking: boolean) => patch("/auth/settings", { activityTracking }), {
    invalidate: [qk.me],
  });
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-medium">Your activity</h2>
      <p className="muted text-xs">
        Which screens you spend time on and which actions you use, kept on this server only and never sent anywhere
        else. Screens are recorded by type (such as "a page in the editor"), never which project, chapter or page, and
        nothing you write is recorded. Export it to share in a feature request.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={on}
          disabled={toggle.isPending}
          onChange={(e) => toggle.mutate(e.target.checked)}
        />
        Record my activity
      </label>
      <ActivityView path="/me/activity" scope="user" />
      <button type="button" className="btn-ghost text-xs text-red-600" onClick={() => setConfirm(true)}>
        Delete my activity
      </button>
      <ConfirmDialog
        open={confirm}
        danger
        title="Delete your activity?"
        confirmLabel="Delete"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            await del("/me/activity");
            await qc.invalidateQueries({ queryKey: ["activity"] });
          } catch (e) {
            toast.error(e);
          }
          setConfirm(false);
        }}
      >
        Every screen and action total recorded for you is deleted. Recording continues unless you turn it off.
      </ConfirmDialog>
    </section>
  );
}

/** Admin: totals across users, with how many used each, never who. */
export function AdminActivity() {
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-medium">Activity</h2>
      <p className="muted text-xs">
        Totals across everyone who records activity, kept on this server only. It shows how many people used each screen
        or action, never who.
      </p>
      <ActivityView path="/admin/activity" scope="instance" />
    </section>
  );
}
