import type { ProjectSettings, VideoHook } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { API_BASE, get, patch } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { Field } from "../../components/ui.tsx";

type Video = NonNullable<ProjectSettings["video"]>;
/** A v4 uuid; `crypto.randomUUID` exists only on https and localhost, and a self-hosted LAN install may be plain http. */
const uuid = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** About how fast the narrator speaks, for the length hint. */
const WORDS_PER_SECOND = 2.6;

/**
 * Hook variants: alternative openings in front of the same film (panel cut), each its own narration over 1–6 panels
 * with an optional title and thumbnail headline for that version's upload. Saved to the project's video settings.
 */
export function HookVariants({ projectId, video }: { projectId: string; video: Video | undefined }) {
  const [hooks, setHooks] = useState<VideoHook[]>(video?.hooks ?? []);
  const save = useAction(
    () =>
      patch(`/projects/${projectId}`, {
        settings: { video: { fadeAtSceneBreaks: false, ...video, hooks } },
      }),
    { invalidate: [qk.project(projectId)], success: "Hook variants saved" },
  );
  const set = (i: number, h: Partial<VideoHook>) => setHooks(hooks.map((x, k) => (k === i ? { ...x, ...h } : x)));
  const valid = hooks.every((h) => h.label.trim() && h.text.trim() && h.panelIds.length);
  return (
    <details className="sm:col-span-2">
      <summary className="cursor-pointer text-sm">Hook variants ({hooks.length})</summary>
      <p className="muted mt-1 text-xs">
        Alternative openings in front of the same film: each one's narration (15–30 s) over panels you pick, then the
        intro card and the film. Rendering another variant only encodes its own shots.
      </p>
      <ul className="mt-2 space-y-3" aria-label="Hook variants">
        {hooks.map((h, i) => {
          const words = h.text.split(/\s+/).filter(Boolean).length;
          return (
            <li key={h.id} className="space-y-2 rounded-lg border border-[var(--border)] p-2">
              <div className="flex gap-2">
                <input
                  className="input flex-1"
                  aria-label="Hook name"
                  placeholder="Name, e.g. Mystery"
                  maxLength={60}
                  value={h.label}
                  onChange={(e) => set(i, { label: e.target.value })}
                />
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label={`Remove ${h.label || "hook"}`}
                  onClick={() => setHooks(hooks.filter((_, k) => k !== i))}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <Field label="Narration" hint={`${words} words, about ${Math.round(words / WORDS_PER_SECOND)} s`}>
                <textarea
                  className="input min-h-20"
                  maxLength={600}
                  value={h.text}
                  onChange={(e) => set(i, { text: e.target.value })}
                />
              </Field>
              <PanelPick projectId={projectId} value={h.panelIds} onChange={(panelIds) => set(i, { panelIds })} />
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Title for this version (optional)">
                  <input
                    className="input"
                    maxLength={100}
                    value={h.title}
                    onChange={(e) => set(i, { title: e.target.value })}
                  />
                </Field>
                <Field label="Thumbnail headline (optional)">
                  <input
                    className="input"
                    maxLength={60}
                    value={h.thumbnailHeadline}
                    onChange={(e) => set(i, { thumbnailHeadline: e.target.value })}
                  />
                </Field>
              </div>
              {h.thumbnailHeadline.trim() && video?.hooks?.some((x) => x.id === h.id) && (
                // The project's thumbnail art with this version's headline (Publishing → thumbnail must exist).
                <a
                  className="text-xs underline"
                  href={`${API_BASE}/projects/${projectId}/thumbnail.png?${new URLSearchParams({ title: h.thumbnailHeadline, download: "1" })}`}
                >
                  Download this version's thumbnail
                </a>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={hooks.length >= 10}
          onClick={() =>
            setHooks([...hooks, { id: uuid(), label: "", text: "", panelIds: [], title: "", thumbnailHeadline: "" }])
          }
        >
          <Plus className="size-4" /> Add a hook
        </button>
        <button type="button" className="btn-primary" disabled={!valid || save.isPending} onClick={() => save.mutate()}>
          Save hook variants
        </button>
      </div>
    </details>
  );
}

/** Up to six panels, picked chapter by chapter; they play in story order. */
function PanelPick({
  projectId,
  value,
  onChange,
}: {
  projectId: string;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [chapterId, setChapterId] = useState("");
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
    select: (r) => r.chapters,
  });
  const panels = useQuery({
    queryKey: ["chapter", chapterId, "panels"],
    queryFn: () =>
      get<{ panels: { id: string; order: number; pageOrder: number; storyBeat: string }[] }>(
        `/chapters/${chapterId}/panels`,
      ),
    select: (r) => r.panels,
    enabled: Boolean(chapterId),
  });
  return (
    <div className="space-y-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="label">Opening panels ({value.length}/6, in story order)</span>
        <select
          className="input w-auto py-1 text-xs"
          aria-label="Pick panels from"
          value={chapterId}
          onChange={(e) => setChapterId(e.target.value)}
        >
          <option value="">Chapter…</option>
          {chapters.data?.map((c) => (
            <option key={c.id} value={c.id}>
              ch. {c.order}: {c.title}
            </option>
          ))}
        </select>
        {value.length > 0 && (
          <button type="button" className="btn-ghost text-xs" onClick={() => onChange([])}>
            Clear
          </button>
        )}
      </div>
      <div className="flex max-h-28 flex-wrap gap-1 overflow-auto">
        {panels.data?.map((p) => (
          <label key={p.id} className="chip cursor-pointer text-xs" title={p.storyBeat}>
            <input
              type="checkbox"
              className="mr-1"
              checked={value.includes(p.id)}
              disabled={!value.includes(p.id) && value.length >= 6}
              onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))}
            />
            p{p.pageOrder}·{p.order}
          </label>
        ))}
      </div>
    </div>
  );
}
