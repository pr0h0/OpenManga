import { Link } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Download, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { patch, post } from "../../../api/client.ts";
import { qk, useAction, useMeta } from "../../../api/hooks.ts";
import type { PageDocument } from "../../../api/types.ts";
import { ConfirmDialog, clsx, Field, StatusChip } from "../../../components/ui.tsx";
import { ActiveBatches } from "../../generation/BatchStatus.tsx";
import { useProject, useProjectId } from "../../project/ProjectLayout.tsx";
import { PreviewVideoButton } from "../../video/VideoPreview.tsx";
import { BulkGenerateButton, LayoutThumb } from "../BulkGenerate.tsx";
import { EdgePicker } from "../EdgePicker.tsx";
import { useEditor } from "./store.ts";

export function PageTab({ data }: { data: PageDocument }) {
  const projectId = useProjectId();
  const { data: meta } = useMeta();
  const film = useProject().data?.project.settings.format === "film";
  const p = data.page;
  const [form, setForm] = useState({
    purpose: p.purpose,
    pacing: p.pacing,
    visualEmphasis: p.visualEmphasis,
    pageTurnHook: p.pageTurnHook,
  });
  const [swap, setSwap] = useState<string | null>(null);
  // The panels' border when they all share one (or all follow the project's): shown as the page-wide choice.
  const panelEdge = useEditor((s) => {
    const edges = s.doc.panels.map((pn) => pn.frame.edge);
    const first = edges[0];
    return first && edges.every((e) => e?.style === first.style && e.size === first.size) ? first : undefined;
  });
  useEffect(
    () =>
      setForm({ purpose: p.purpose, pacing: p.pacing, visualEmphasis: p.visualEmphasis, pageTurnHook: p.pageTurnHook }),
    [p.id, p.updatedAt],
  );
  const inv = [qk.page(p.id), qk.chapter(p.chapterId)];
  const save = useAction((body: Record<string, unknown>) => patch(`/pages/${p.id}`, body), {
    invalidate: inv,
    success: "Page saved",
  });
  const layout = useAction((layoutTemplate: string) => post(`/pages/${p.id}/layout`, { layoutTemplate }), {
    invalidate: inv,
    success: "Layout applied",
    onSuccess: () => setSwap(null),
  });
  const exportPng = useAction(() => post(`/projects/${projectId}/exports`, { kind: "png_pages", pageIds: [p.id] }), {
    invalidate: [qk.exports(projectId)],
    success: "PNG export queued — find it under Exports",
  });
  const idx = data.siblings.findIndex((s) => s.id === p.id);
  const prev = data.siblings[idx - 1];
  const next = data.siblings[idx + 1];
  const locked = p.status === "locked";

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center justify-between">
        {prev ? (
          <Link
            to="/projects/$projectId/pages/$pageId"
            params={{ projectId, pageId: prev.id }}
            search={{}}
            className="btn-ghost"
          >
            <ChevronLeft className="size-4" /> Page {prev.order}
          </Link>
        ) : (
          <span />
        )}
        <span className="muted text-xs">
          Page {p.order} of {data.siblings.length}
        </span>
        {next ? (
          <Link
            to="/projects/$projectId/pages/$pageId"
            params={{ projectId, pageId: next.id }}
            search={{}}
            className="btn-ghost"
          >
            Page {next.order} <ChevronRight className="size-4" />
          </Link>
        ) : (
          <span />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <StatusChip status={p.status} />
        {p.status === "draft" && (
          <button type="button" className="btn-secondary py-1" onClick={() => save.mutate({ status: "approved" })}>
            Approve page
          </button>
        )}
        {p.status === "approved" && (
          <>
            <button type="button" className="btn-secondary py-1" onClick={() => save.mutate({ status: "draft" })}>
              Unapprove
            </button>
            <button type="button" className="btn-secondary py-1" onClick={() => save.mutate({ status: "locked" })}>
              <Lock className="size-3.5" /> Lock
            </button>
          </>
        )}
      </div>
      <fieldset disabled={locked} className="space-y-3">
        {(["purpose", "pacing", "visualEmphasis", "pageTurnHook"] as const).map((k) => (
          <Field
            key={k}
            label={
              {
                purpose: "Page purpose",
                pacing: "Pacing",
                visualEmphasis: "Visual emphasis",
                pageTurnHook: "Page-turn hook",
              }[k]
            }
          >
            <textarea
              className="input"
              rows={2}
              value={form[k]}
              onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))}
            />
          </Field>
        ))}
        <button
          type="button"
          className="btn-primary w-full"
          disabled={save.isPending}
          onClick={() => save.mutate(form)}
        >
          Save page plan
        </button>
        <div hidden={film} className="space-y-2 rounded-lg border border-[var(--border)] p-2">
          <div className="label">Borders</div>
          <EdgePicker
            label="This page's edge"
            inheritLabel="Project default"
            value={p.edge ?? undefined}
            onChange={(edge) => save.mutate({ edge: edge ?? null })}
          />
          <EdgePicker
            label="Every panel on this page"
            inheritLabel="Project default"
            value={panelEdge}
            onChange={(edge) =>
              useEditor.getState().commit((d) => ({
                ...d,
                panels: d.panels.map((pn) => {
                  const { edge: _e, ...frame } = pn.frame;
                  return { ...pn, frame: edge ? { ...frame, edge } : frame };
                }),
              }))
            }
          />
          <p className="muted text-xs">
            The page edge overrides the project's for this page only. The panel border is set on every panel of the page
            at once; a panel can still change its own on its Panel tab.
          </p>
        </div>
        <div hidden={film}>
          <div className="label">
            Layout template {p.layoutTemplate ? `(current: ${p.layoutTemplate})` : "(custom)"}
          </div>
          <div className="grid grid-cols-4 gap-1.5">
            {meta?.layouts.map((t) => (
              <button
                key={t.key}
                type="button"
                title={t.name}
                aria-label={`Use layout ${t.name}`}
                onClick={() => setSwap(t.key)}
                className={clsx(
                  "card flex flex-col items-center p-1.5 text-[10px] hover:border-accent-500",
                  p.layoutTemplate === t.key && "border-accent-500",
                )}
              >
                <LayoutThumb frames={t.frames} className="h-10 w-7" />
              </button>
            ))}
          </div>
        </div>
      </fieldset>
      <div className="grid gap-2">
        <BulkGenerateButton
          projectId={projectId}
          scope={{ pageId: p.id }}
          label={film ? "Generate shot" : "Generate page"}
        />
        <ActiveBatches projectId={projectId} pageId={p.id} compact />
        <PreviewVideoButton
          projectId={projectId}
          scope={{ pageId: p.id }}
          label={film ? "Preview shot video" : "Preview page video"}
          title={`Preview — page ${p.order}`}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={exportPng.isPending}
          onClick={() => exportPng.mutate()}
        >
          <Download className="size-4" /> Export page PNG
        </button>
      </div>
      <ConfirmDialog
        open={Boolean(swap)}
        title="Swap layout template?"
        confirmLabel="Apply layout"
        busy={layout.isPending}
        onClose={() => setSwap(null)}
        onConfirm={() => swap && layout.mutate(swap)}
      >
        Existing panels are moved into the new frames in reading order (artwork and lettering are kept). Missing frames
        get new empty panels.
      </ConfirmDialog>
    </div>
  );
}
