import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { MonitorSmartphone, Plus, Redo2, Undo2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { del, get, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { PageDocument } from "../../api/types.ts";
import { ConfirmDialog, ErrorBox, SaveIndicator, Spinner, Tabs, toast } from "../../components/ui.tsx";
import { CommentBadge, PanelComments, useCommentCounts } from "../comments/comments.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";
import { BulkGenerateButton } from "./BulkGenerate.tsx";
import { EditorCanvas, useView } from "./editor/Canvas.tsx";
import { LetteringTab } from "./editor/LetteringTab.tsx";
import { PageTab } from "./editor/PageTab.tsx";
import { PanelList, PanelTab } from "./editor/PanelTab.tsx";
import { PromptTab } from "./editor/PromptTab.tsx";
import { clampBox, clampFrame, useEditor } from "./editor/store.ts";
import { VersionsTab } from "./editor/VersionsTab.tsx";

type Tab = "panel" | "prompt" | "versions" | "lettering" | "comments" | "page";

function useWide() {
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 900);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

export function PageEditorPage() {
  const projectId = useProjectId();
  // Only the owner deletes panels; an editor turns one off under Video shot instead.
  const canDeletePanels = useProject().data?.role === "owner";
  const { pageId } = useParams({ strict: false }) as { pageId: string };
  const search = useSearch({ strict: false }) as { panelId?: string; tab?: "comments" };
  const qc = useQueryClient();
  const wide = useWide();
  const q = useQuery({ queryKey: qk.page(pageId), queryFn: () => get<PageDocument>(`/pages/${pageId}`) });
  const { hydrate, select, undo, redo } = useEditor.getState();
  const selection = useEditor((s) => s.selection);
  const saveState = useEditor((s) => s.saveState);
  const canUndo = useEditor((s) => s.past.length > 0);
  const canRedo = useEditor((s) => s.future.length > 0);
  const [tab, setTab] = useState<Tab>(search.tab ?? "panel");
  const counts = useCommentCounts(projectId).data;
  const [narrowPanelId, setNarrowPanelId] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    if (q.data) hydrate(pageId, q.data, search.panelId);
  }, [q.data, pageId, hydrate]);
  useEffect(() => {
    useEditor.setState({ onSaved: () => void qc.invalidateQueries({ queryKey: qk.page(pageId) }) });
    return () => {
      void useEditor.getState().flush();
      useEditor.setState({ onSaved: null });
    };
  }, [pageId, qc]);
  useEffect(() => {
    if (search.panelId) select({ type: "panel", ids: [search.panelId] });
    // A link to a comment opens the panel's comments, here and in the phone layout's picker.
    if (search.tab) setTab(search.tab);
    if (search.tab && search.panelId) setNarrowPanelId(search.panelId);
  }, [search.panelId, search.tab, pageId]);
  useEffect(() => {
    if (selection && selection.type !== "panel") setTab("lettering");
  }, [selection]);
  const hasData = Boolean(q.data);
  useEffect(() => {
    // Reopening the same page keeps the store, so make sure something is selected there too.
    const st = useEditor.getState();
    if (!hasData || search.panelId || st.selection || st.pageId !== pageId) return;
    const first = [...st.doc.panels].sort((a, b) => a.order - b.order)[0];
    if (first) select({ type: "panel", ids: [first.id] });
  }, [hasData, pageId, search.panelId]);

  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: qk.page(pageId) }), [qc, pageId]);
  const deletePanel = async (id: string) => {
    try {
      await del(`/panels/${id}`);
      select(null);
      await refresh();
    } catch (e) {
      toast.error(e);
    }
    setConfirmDelete(null);
  };

  useEffect(() => {
    const onKey = async (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true]") || document.querySelector("[role=dialog]"))
        return;
      const mod = e.ctrlKey || e.metaKey;
      const st = useEditor.getState();
      const sel = st.selection;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.shiftKey ? st.redo() : st.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        st.redo();
      } else if (mod && e.key.toLowerCase() === "d" && sel?.type === "panel") {
        e.preventDefault();
        try {
          await post(`/pages/${pageId}/panels`, { duplicateOf: sel.ids[0] });
          await refresh();
        } catch (err) {
          toast.error(err);
        }
      } else if ((e.key === "Escape" || e.key === "Enter") && st.adjustImageFor) {
        st.setAdjustImage(null);
      } else if (e.key === "Escape") {
        if (st.aimTailFor) st.setAimTail(null);
        else st.select(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && sel) {
        e.preventDefault();
        if (sel.type === "panel") {
          if (canDeletePanels) setConfirmDelete(sel.ids[0]!);
          else toast.info("Only the project owner can delete panels. Turn it off under Video shot instead.");
        } else {
          try {
            await Promise.all(sel.ids.map((id) => del(sel.type === "sfx" ? `/sfx/${id}` : `/dialogue/${id}`)));
            st.select(null);
            await refresh();
          } catch (err) {
            toast.error(err);
          }
        }
      } else if (e.key.startsWith("Arrow") && sel) {
        e.preventDefault();
        const step = e.shiftKey ? 0.02 : 0.002;
        const dx = e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
        const dy = e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
        st.commit((d) => ({
          panels: d.panels.map((p) =>
            sel.type === "panel" && sel.ids.includes(p.id)
              ? { ...p, frame: clampFrame({ ...p.frame, x: p.frame.x + dx, y: p.frame.y + dy }) }
              : p,
          ),
          bubbles: d.bubbles.map((b) =>
            sel.type === "bubble" && sel.ids.includes(b.id)
              ? { ...b, bubble: clampBox({ ...b.bubble, x: b.bubble.x + dx, y: b.bubble.y + dy }) }
              : b,
          ),
          sfx: d.sfx.map((s) =>
            sel.type === "sfx" && sel.ids.includes(s.id)
              ? {
                  ...s,
                  style: {
                    ...s.style,
                    x: Math.min(1, Math.max(0, s.style.x + dx)),
                    y: Math.min(1, Math.max(0, s.style.y + dy)),
                  },
                }
              : s,
          ),
        }));
      } else if (e.key === "+" || e.key === "=") useView.getState().zoomBy(1.2);
      else if (e.key === "-") useView.getState().zoomBy(1 / 1.2);
      else if (e.key === "0") useView.getState().fit();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageId, refresh, canDeletePanels]);

  if (q.isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (q.error)
    return (
      <div className="p-6">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const data = q.data!;
  const selectedPanelId = selection?.type === "panel" && selection.ids.length === 1 ? selection.ids[0]! : null;
  const selectedPanel = data.panels.find((p) => p.id === selectedPanelId);
  const letteringPanelId =
    selectedPanelId ??
    (selection && selection.type !== "panel"
      ? (useEditor.getState().doc.bubbles.find((b) => b.id === selection.ids[0])?.panelId ??
        useEditor.getState().doc.sfx.find((s) => s.id === selection.ids[0])?.panelId ??
        null)
      : null);

  const header = (
    <div className="flex items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-3 py-1.5">
      <Link
        to="/projects/$projectId/pages"
        params={{ projectId }}
        search={{ chapterId: data.chapter.id }}
        className="btn-ghost text-xs"
      >
        ← Ch. {data.chapter.order}
      </Link>
      <div className="text-sm font-medium">Page {data.page.order}</div>
      <span className="muted hidden text-xs lg:inline">
        {data.page.width}×{data.page.height} · {data.readingDirection.toUpperCase()}
      </span>
      {wide && (
        <div className="ml-auto flex items-center gap-1">
          <SaveIndicator state={saveState} />
          <button
            type="button"
            className="btn-ghost p-1.5"
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
            disabled={!canUndo}
            onClick={undo}
          >
            <Undo2 className="size-4" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5"
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
            disabled={!canRedo}
            onClick={redo}
          >
            <Redo2 className="size-4" />
          </button>
          <button
            type="button"
            className="btn-secondary py-1 text-xs"
            onClick={async () => {
              try {
                const r = await post<{ panel: { id: string } }>(`/pages/${pageId}/panels`, {});
                await refresh();
                select({ type: "panel", ids: [r.panel.id] });
              } catch (e) {
                toast.error(e);
              }
            }}
          >
            <Plus className="size-3.5" /> Panel
          </button>
        </div>
      )}
    </div>
  );

  if (!wide)
    return (
      <div className="flex h-full flex-col">
        {header}
        <div
          className="flex items-center gap-2 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          role="note"
        >
          <MonitorSmartphone className="size-4" /> Desktop recommended — the page editor is read-only on small screens.
        </div>
        <div className="min-h-0 flex-1">
          <EditorCanvas data={data} readOnly />
        </div>
        {/* Comments work on a phone even though editing does not: pick a panel, read and reply. */}
        <section className="max-h-[50%] overflow-y-auto border-t border-[var(--border)] p-3" aria-label="Comments">
          <label className="label" htmlFor="comment-panel">
            Comments on
          </label>
          <select
            id="comment-panel"
            className="input mb-2"
            value={narrowPanelId || selectedPanelId || ""}
            onChange={(e) => setNarrowPanelId(e.target.value)}
          >
            <option value="">Choose a panel…</option>
            {[...data.panels]
              .sort((a, b) => a.order - b.order)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  Panel {p.order}
                  {counts?.panels[p.id] ? ` (${counts.panels[p.id]} open)` : ""} — {p.storyBeat || "Untitled"}
                </option>
              ))}
          </select>
          {(narrowPanelId || selectedPanelId) && (
            <PanelComments projectId={projectId} panelId={narrowPanelId || selectedPanelId!} />
          )}
        </section>
      </div>
    );

  return (
    <div className="flex h-full flex-col">
      {header}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <EditorCanvas data={data} />
        </div>
        <aside
          className="flex w-[23rem] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--panel)]"
          aria-label="Inspector"
        >
          <div className="px-3 pt-2">
            <Tabs<Tab>
              dense
              value={tab}
              onChange={setTab}
              tabs={[
                { value: "panel", label: "Panel" },
                { value: "prompt", label: "Prompt" },
                { value: "versions", label: "Versions" },
                { value: "lettering", label: "Lettering" },
                {
                  value: "comments",
                  label: counts?.pages[pageId] ? `Comments (${counts.pages[pageId]})` : "Comments",
                },
                { value: "page", label: "Page" },
              ]}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
            {tab === "page" && <PageTab data={data} />}
            {tab === "lettering" && <LetteringTab data={data} panelId={letteringPanelId} />}
            {tab === "panel" && !selectedPanel && (
              <div className="space-y-3">
                <p className="muted text-xs">
                  {selection?.type === "panel"
                    ? `${selection.ids.length} panels selected — select one to edit it.`
                    : "Select a panel on the canvas or in the list. Shift+click selects several."}
                </p>
                {selection?.type === "panel" && selection.ids.length > 1 && (
                  <BulkGenerateButton
                    projectId={projectId}
                    scope={{ panelIds: selection.ids }}
                    label={`Generate ${selection.ids.length} selected panels`}
                  />
                )}
                <PanelList data={data} onDelete={canDeletePanels ? setConfirmDelete : undefined} />
              </div>
            )}
            {selectedPanel && tab === "comments" && (
              <PanelComments key={selectedPanel.id} projectId={projectId} panelId={selectedPanel.id} />
            )}
            {(tab === "prompt" || tab === "versions" || tab === "comments") && !selectedPanel && (
              <div className="space-y-2">
                <p className="muted text-xs">
                  {selection?.type === "panel" && selection.ids.length > 1
                    ? `${selection.ids.length} panels selected — pick one to see its ${tab === "prompt" ? "prompt" : tab === "comments" ? "comments" : "artwork versions"}.`
                    : `Pick a panel to see its ${tab === "prompt" ? "prompt and generation controls" : tab === "comments" ? "comments" : "artwork versions"}.`}
                </p>
                <ul className="space-y-1" aria-label="Choose a panel">
                  {[...data.panels]
                    .sort((a, b) => a.order - b.order)
                    .map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className="btn-secondary w-full justify-start text-left text-xs"
                          onClick={() => select({ type: "panel", ids: [p.id] })}
                        >
                          <span className="font-semibold">{p.order}</span>
                          <span className="truncate">{p.storyBeat || "Untitled panel"}</span>
                          <CommentBadge n={counts?.panels[p.id]} className="ml-auto" />
                        </button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
            {selectedPanel && tab === "panel" && (
              <div className="space-y-4">
                <PanelTab
                  key={selectedPanel.id}
                  data={data}
                  panel={selectedPanel}
                  onDelete={canDeletePanels ? setConfirmDelete : undefined}
                />
                <div>
                  <div className="label">Reading order</div>
                  <PanelList data={data} onDelete={canDeletePanels ? setConfirmDelete : undefined} />
                </div>
              </div>
            )}
            {selectedPanel && tab === "prompt" && (
              <PromptTab key={selectedPanel.id} data={data} panel={selectedPanel} />
            )}
            {selectedPanel && tab === "versions" && (
              <VersionsTab key={selectedPanel.id} panel={selectedPanel} pageId={pageId} />
            )}
          </div>
        </aside>
      </div>
      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete panel?"
        danger
        confirmLabel="Delete panel"
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && void deletePanel(confirmDelete)}
      >
        The panel and its spec are removed from the page. Its generated artwork remains in the asset library.
      </ConfirmDialog>
    </div>
  );
}
