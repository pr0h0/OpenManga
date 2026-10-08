import { RETENTION_LABELS, type RetentionKind } from "@openmanga/domain/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { useEffect, useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { ErrorBox, Field, fmt, Spinner } from "../../components/ui.tsx";

type Policy = { enabled: boolean; maxAgeDays: number | null; maxTotalGb: number | null; mode: "auto" | "approve" };
type Summary = {
  computedAt: string;
  files: number;
  bytes: number;
  totalBytes: number;
  afterBytes: number;
  overLimitBytes: number;
  reasons: { age: number; size: number };
  byKind: Partial<Record<RetentionKind, { files: number; bytes: number }>>;
};
type StorageView = {
  policy: Policy;
  usage: { totalBytes: number; expendable: Partial<Record<RetentionKind, { files: number; bytes: number }>> };
  preview: Summary | null;
  pending: Summary | null;
  disk: { totalBytes: number; freeBytes: number } | null;
};
export const storageKeys = { view: ["admin", "storage"] as const, alert: ["admin", "storage", "alert"] as const };

/** What a summary deletes, kind by kind. */
export function SummaryList({ s }: { s: Summary }) {
  return (
    <ul className="list-inside list-disc text-xs">
      {Object.entries(s.byKind).map(([k, v]) => (
        <li key={k}>
          {RETENTION_LABELS[k as RetentionKind]}: {v!.files} file(s), {fmt.bytes(v!.bytes)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The server's storage policy: a maximum age and a maximum total size for the files the app can do without, applied by
 * the hourly maintenance pass, either at once or after an administrator approves.
 */
export function StorageTab() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: storageKeys.view, queryFn: () => get<StorageView>("/admin/storage") });
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => {
    if (q.data && !p) setP(q.data.policy);
  }, [q.data, p]);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: storageKeys.view });
    void qc.invalidateQueries({ queryKey: storageKeys.alert });
  };
  const save = useAction((v: Policy) => put<StorageView>("/admin/storage/policy", v), {
    success: "Storage policy saved",
    onSuccess: (v) => {
      qc.setQueryData(storageKeys.view, v);
      setP(v.policy);
      void qc.invalidateQueries({ queryKey: storageKeys.alert });
    },
  });
  const approve = useAction(() => post("/admin/storage/approve"), {
    success: "Deleting: the warning clears when it is done",
    onSuccess: () => setTimeout(refresh, 3000),
  });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data || !p) return <Spinner />;
  const d = q.data;
  const expendable = Object.values(d.usage.expendable).reduce((n, v) => n + (v?.bytes ?? 0), 0);
  const number = (v: string) => (v.trim() === "" ? null : Number(v));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <section className="card space-y-3 p-4">
        <h2 className="flex items-center gap-2 font-medium">
          <HardDrive className="size-4" /> Storage policy
        </h2>
        <p className="muted text-xs">
          Files the app can do without are deleted when they are older than the age limit, and then the oldest of them
          until everything stored is under the size limit — whichever is crossed first. Never deleted: artwork a panel
          shows, approved or locked art, references, covers, thumbnails, your uploads, and narration a line plays.
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
          Apply a storage policy
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Delete files older than (days)" hint="Empty: no age limit">
            <input
              className="input"
              type="number"
              min={1}
              value={p.maxAgeDays ?? ""}
              onChange={(e) => setP({ ...p, maxAgeDays: number(e.target.value) })}
            />
          </Field>
          <Field label="Keep total storage under (GB)" hint="Empty: no size limit">
            <input
              className="input"
              type="number"
              min={1}
              value={p.maxTotalGb ?? ""}
              onChange={(e) => setP({ ...p, maxTotalGb: number(e.target.value) })}
            />
          </Field>
        </div>
        <fieldset className="space-y-1 text-sm">
          <legend className="label">When files are due</legend>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="storage-mode"
              checked={p.mode === "approve"}
              onChange={() => setP({ ...p, mode: "approve" })}
            />
            <span>
              Ask me first
              <span className="muted block text-xs">
                A warning stays at the top of every page for administrators until you approve or change the policy.
              </span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="storage-mode"
              checked={p.mode === "auto"}
              onChange={() => setP({ ...p, mode: "auto" })}
            />
            <span>
              Delete automatically
              <span className="muted block text-xs">
                At the hourly maintenance pass, with an entry in the audit log.
              </span>
            </span>
          </label>
        </fieldset>
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate(p)}>
          Save policy
        </button>
      </section>

      <section className="card space-y-3 p-4">
        <h2 className="font-medium">Usage</h2>
        <p className="text-sm">
          {fmt.bytes(d.usage.totalBytes)} stored, {fmt.bytes(expendable)} of it expendable
          {d.disk && ` · disk ${fmt.bytes(d.disk.freeBytes)} free of ${fmt.bytes(d.disk.totalBytes)}`}
        </p>
        <ul className="space-y-0.5 text-xs">
          {Object.entries(RETENTION_LABELS).map(([k, label]) => {
            const v = d.usage.expendable[k as RetentionKind];
            return (
              <li key={k} className="flex justify-between gap-2">
                <span>{label}</span>
                <span className="muted tabular-nums">{v ? `${v.files} · ${fmt.bytes(v.bytes)}` : "none"}</span>
              </li>
            );
          })}
        </ul>
        {d.pending?.files ? (
          <div className="space-y-2 rounded-lg bg-amber-500/10 p-3 text-sm">
            <p>
              Waiting for your approval:{" "}
              <strong>
                {d.pending.files} file(s), {fmt.bytes(d.pending.bytes)}
              </strong>{" "}
              ({d.pending.reasons.age} past the age limit, {d.pending.reasons.size} to get under the size limit).
            </p>
            <SummaryList s={d.pending} />
            <button type="button" className="btn-danger" disabled={approve.isPending} onClick={() => approve.mutate()}>
              Delete {d.pending.files} file(s) now
            </button>
          </div>
        ) : d.preview ? (
          <div className="space-y-1 text-sm">
            <p>
              Now the policy would delete {d.preview.files} file(s), {fmt.bytes(d.preview.bytes)}, leaving{" "}
              {fmt.bytes(d.preview.afterBytes)}.
            </p>
            <SummaryList s={d.preview} />
          </div>
        ) : (
          <p className="muted text-sm">No policy applies: nothing is deleted.</p>
        )}
        {(d.pending?.overLimitBytes ?? 0) > 0 && (
          <p className="text-sm text-red-600 dark:text-red-400">
            Still {fmt.bytes(d.pending!.overLimitBytes)} over the size limit after every expendable file: the rest is in
            use. Raise the limit or delete projects you no longer need.
          </p>
        )}
      </section>
    </div>
  );
}
