import { RETENTION_KINDS, RETENTION_LABELS, type RetentionKind } from "@openmanga/domain/browser";
import type { ProjectStorage } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { Field, fmt } from "../../components/ui.tsx";

type View = {
  policy: ProjectStorage;
  use: { bytes: number; capBytes: number | null; overCap: boolean };
  expendable: Partial<Record<RetentionKind, { files: number; bytes: number }>>;
  preview: { files: number; bytes: number; afterBytes: number; overLimitBytes: number } | null;
};

/**
 * The project's own storage policy (its owner's): how long each kind of expendable file is kept, and a cap the
 * project stays under. Files a panel shows, approved art, references, uploads and narration in use are never touched.
 */
export function StorageSection({ projectId, owner }: { projectId: string; owner: boolean }) {
  const qc = useQueryClient();
  const key = ["project", projectId, "storage"];
  const q = useQuery({ queryKey: key, queryFn: () => get<View>(`/projects/${projectId}/storage`) });
  if (!q.data) return null;
  return (
    <Form
      key={JSON.stringify(q.data.policy)}
      projectId={projectId}
      owner={owner}
      v={q.data}
      onSaved={(d) => qc.setQueryData(key, d)}
    />
  );
}

function Form({
  projectId,
  owner,
  v,
  onSaved,
}: {
  projectId: string;
  owner: boolean;
  v: View;
  onSaved: (v: View) => void;
}) {
  const [p, setP] = useState<ProjectStorage>(v.policy);
  const save = useAction(() => put<View>(`/projects/${projectId}/storage`, p), {
    success: "Storage policy saved",
    onSuccess: onSaved,
  });
  const apply = useAction(
    () => post<View & { deleted: number; bytes: number }>(`/projects/${projectId}/storage/apply`),
    {
      success: (r) => `Deleted ${r.deleted} file(s), ${fmt.bytes(r.bytes)}`,
      onSuccess: onSaved,
    },
  );
  const days = (x: string) => (x === "" ? null : Math.max(1, Math.round(Number(x))));
  return (
    <section className="card space-y-3 p-4" aria-label="Storage">
      <div>
        <h2 className="font-medium">Storage</h2>
        <p className="muted text-xs">
          This project stores {fmt.bytes(v.use.bytes)}
          {v.use.capBytes !== null ? ` of its ${fmt.bytes(v.use.capBytes)} cap` : ""}.
          {v.use.overCap && (
            <strong className="text-red-600"> Over the cap: new AI work and exports wait until space is freed.</strong>
          )}{" "}
          A policy deletes only files that can be made again or are no longer used, at each hourly maintenance pass;
          artwork a panel shows, approved art, references, uploads and narration in use are never touched.
        </p>
      </div>
      <fieldset
        disabled={!owner}
        className="space-y-3"
        title={owner ? undefined : "Only the project's owner sets this"}
      >
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={p.enabled} onChange={(e) => setP({ ...p, enabled: e.target.checked })} />
          Use a storage policy for this project
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Delete expendable files older than (days)" hint="Empty: no age limit.">
            <input
              className="input"
              type="number"
              min={1}
              value={p.maxAgeDays ?? ""}
              onChange={(e) => setP({ ...p, maxAgeDays: days(e.target.value) })}
            />
          </Field>
          <Field label="Storage cap (GB)" hint="The oldest expendable files go until the project is under it.">
            <input
              className="input"
              type="number"
              min={0.1}
              step={0.1}
              value={p.capGb ?? ""}
              onChange={(e) => setP({ ...p, capGb: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </Field>
        </div>
        <KindAges
          value={p.kindAges}
          defaultDays={p.maxAgeDays}
          expendable={v.expendable}
          onChange={(kindAges) => setP({ ...p, kindAges })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save storage policy
          </button>
          {v.preview && v.preview.files > 0 && (
            <>
              <span className="muted text-xs">
                It would delete {v.preview.files} file(s), {fmt.bytes(v.preview.bytes)}, now.
              </span>
              <button type="button" className="btn-secondary" disabled={apply.isPending} onClick={() => apply.mutate()}>
                Apply now
              </button>
            </>
          )}
          {v.preview && v.preview.files === 0 && <span className="muted text-xs">Nothing to delete now.</span>}
        </div>
      </fieldset>
    </section>
  );
}

type KindAgesValue = Partial<Record<RetentionKind, number | null>> | undefined;

/** Per kind of expendable file: what is stored now, and whether it keeps the general age, its own, or no age limit. */
export function KindAges({
  value,
  defaultDays,
  expendable,
  onChange,
}: {
  value: KindAgesValue;
  defaultDays: number | null;
  expendable: Partial<Record<RetentionKind, { files: number; bytes: number }>>;
  onChange: (v: KindAgesValue) => void;
}) {
  const age = (k: RetentionKind) => value?.[k];
  return (
    <table className="w-full text-sm">
      <thead className="muted text-left text-xs">
        <tr>
          <th className="py-1 font-medium">Kind</th>
          <th className="py-1 font-medium">Stored now</th>
          <th className="py-1 font-medium">Keep for</th>
        </tr>
      </thead>
      <tbody>
        {RETENTION_KINDS.map((k) => (
          <tr key={k} className="border-t border-[var(--border)]">
            <td className="py-1">{RETENTION_LABELS[k]}</td>
            <td className="muted py-1 text-xs">
              {expendable[k] ? `${expendable[k]!.files} · ${fmt.bytes(expendable[k]!.bytes)}` : "—"}
            </td>
            <td className="py-1">
              <select
                className="input w-auto py-0.5 text-xs"
                aria-label={`${RETENTION_LABELS[k]}: how long`}
                value={age(k) === undefined ? "default" : age(k) === null ? "never" : "days"}
                onChange={(e) => {
                  const rest = { ...value };
                  if (e.target.value === "default") delete rest[k];
                  else rest[k] = e.target.value === "never" ? null : (defaultDays ?? 30);
                  onChange(rest);
                }}
              >
                <option value="default">Like the rest</option>
                <option value="days">Its own age</option>
                <option value="never">No age limit</option>
              </select>
              {typeof age(k) === "number" && (
                <input
                  className="input ml-1 w-20 py-0.5 text-xs"
                  type="number"
                  min={1}
                  aria-label={`${RETENTION_LABELS[k]}: days`}
                  value={age(k)!}
                  onChange={(e) => onChange({ ...value, [k]: Math.max(1, Math.round(Number(e.target.value) || 1)) })}
                />
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
