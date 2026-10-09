import type { CustomLayout } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import { ConfirmDialog, Spinner, toast } from "../../components/ui.tsx";
import { LayoutThumb } from "./BulkGenerate.tsx";

/**
 * Project settings → Page layouts: the user's saved layouts, each one on or off for this project (on copies it into
 * the project, so collaborators plan with it too), renamed or deleted from the library, and the whole project re-laid
 * with the ones on.
 */
export function LayoutLibrary({
  projectId,
  value,
  onChange,
  disabled,
}: {
  projectId: string;
  value: CustomLayout[] | undefined;
  onChange: (v: CustomLayout[]) => void;
  disabled?: boolean;
}) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["layouts"], queryFn: () => get<{ layouts: CustomLayout[] }>("/layouts") });
  const [busy, setBusy] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const inProject = value ?? [];
  // Copies used here whose original left the library are still listed, so they can be turned off.
  const all = [...(q.data?.layouts ?? []), ...inProject.filter((l) => !q.data?.layouts.some((x) => x.id === l.id))];
  const refresh = () => qc.invalidateQueries({ queryKey: ["layouts"] });
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-medium">Page layouts</h2>
      <p className="muted text-xs">
        Your saved layouts (save one from any page: page editor → Page tab → Save as layout). Turn on the ones this
        project uses: planning a chapter gives each new page one with its number of panels, in turn, and you can re-lay
        existing pages with them here or on a chapter. Pages no layout fits keep the built-in templates.
      </p>
      {q.isLoading && <Spinner />}
      {q.data && !all.length && <p className="muted text-sm">No saved layouts yet.</p>}
      <ul className="grid gap-2 sm:grid-cols-2">
        {all.map((l) => {
          const on = inProject.some((x) => x.id === l.id);
          const inLibrary = q.data?.layouts.some((x) => x.id === l.id);
          return (
            <li key={l.id} className="flex items-center gap-2 rounded-lg border border-[var(--border)] p-2">
              <LayoutThumb frames={l.frames} className="h-12 w-8 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <input
                  className="input py-1 text-sm"
                  aria-label={`Name of ${l.name}`}
                  defaultValue={l.name}
                  disabled={!inLibrary || disabled}
                  onBlur={(e) => {
                    const name = e.target.value.trim();
                    if (inLibrary && name && name !== l.name)
                      void run(async () => {
                        await patch(`/layouts/${l.id}`, { name });
                        await refresh();
                        if (on) onChange(inProject.map((x) => (x.id === l.id ? { ...x, name } : x)));
                      });
                  }}
                />
                <label className="flex items-center gap-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={disabled}
                    onChange={(e) =>
                      onChange(e.target.checked ? [...inProject, l] : inProject.filter((x) => x.id !== l.id))
                    }
                  />
                  Use in this project · {l.frames.length} panel{l.frames.length === 1 ? "" : "s"}
                </label>
              </div>
              {inLibrary && (
                <button
                  type="button"
                  className="btn-ghost p-1"
                  aria-label={`Delete ${l.name}`}
                  disabled={busy || disabled}
                  onClick={() =>
                    void run(async () => {
                      await del(`/layouts/${l.id}`);
                      await refresh();
                    })
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || disabled || !inProject.length}
        onClick={() => setConfirmApply(true)}
      >
        Re-lay every page with these layouts
      </button>
      <ConfirmDialog
        open={confirmApply}
        title="Re-lay every page of the project?"
        confirmLabel="Re-lay pages"
        busy={busy}
        onClose={() => setConfirmApply(false)}
        onConfirm={() =>
          void run(async () => {
            const r = await post<{ changed: number; skipped: number }>(`/projects/${projectId}/apply-layouts`, {});
            setConfirmApply(false);
            toast.success(`${r.changed} page(s) re-laid; ${r.skipped} kept (no layout with their number of panels)`);
          })
        }
      >
        Each page takes one of the layouts on with its number of panels, in turn; the panels keep their art and text. If
        you just turned layouts on, wait until the page says Saved. Locked pages and pages no layout fits stay as they
        are.
      </ConfirmDialog>
    </section>
  );
}
