import { EXPORT_TARGETS, type ExportTarget, exportTarget, type TargetIssue } from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import { get } from "../../api/client.ts";
import { clsx, Field } from "../../components/ui.tsx";

/**
 * A platform target: picking one applies its export settings, shows what a check cannot measure (safe areas, naming,
 * codecs) and checks the platform's limits against this project before exporting. The files are checked again once
 * made (the export's result).
 */
export function ExportTargetPicker({
  projectId,
  kinds,
  value,
  onChange,
  chapterId,
  minHoldMs,
  durationMs,
}: {
  projectId: string;
  /** The export kinds this page offers. */
  kinds: readonly string[];
  value: string;
  onChange: (t: ExportTarget | null) => void;
  chapterId: string | null;
  minHoldMs: number;
  /** A Shorts cut's chosen length. */
  durationMs?: number;
}) {
  const t = exportTarget(value);
  const params = new URLSearchParams({
    ...(chapterId ? { chapterId } : {}),
    minHoldMs: String(minHoldMs),
    ...(durationMs != null ? { durationMs: String(durationMs) } : {}),
  });
  const check = useQuery({
    queryKey: ["export-target", projectId, value, params.toString()],
    queryFn: () => get<{ issues: TargetIssue[] }>(`/projects/${projectId}/export-targets/${value}/check?${params}`),
    enabled: Boolean(t),
  });
  return (
    <div className="space-y-2">
      <Field label="Export for" hint="A platform: sets the export for it and checks its limits first.">
        <select className="input" value={value} onChange={(e) => onChange(exportTarget(e.target.value) ?? null)}>
          <option value="">None</option>
          {EXPORT_TARGETS.filter((x) => kinds.includes(x.kind)).map((x) => (
            <option key={x.key} value={x.key}>
              {x.label}
            </option>
          ))}
        </select>
      </Field>
      {t && (
        <section aria-label="Platform check" className="space-y-1 rounded-lg border border-[var(--border)] p-2 text-xs">
          <ul className="muted list-disc pl-4">
            {t.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          {check.data &&
            (check.data.issues.length ? (
              <ul className="space-y-0.5">
                {check.data.issues.map((i) => (
                  <li key={i.code} className={clsx(i.level === "block" ? "text-red-600" : "text-amber-600")}>
                    {i.message}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-emerald-600">
                Within {t.label}'s limits so far; the files are checked again once made.
              </p>
            ))}
        </section>
      )}
    </div>
  );
}
