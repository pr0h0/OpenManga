import { ChevronDown, ChevronRight, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { del, patch, put } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import type { ChapterDetail } from "../../api/types.ts";
import { ConfirmDialog, TagInput } from "../../components/ui.tsx";
import { BulkGenerateButton } from "../pages/BulkGenerate.tsx";

type Scene = ChapterDetail["scenes"][number];
type Option = { id: string; name: string };
const TEXT_FIELDS = [
  ["purpose", "Purpose"],
  ["opening", "Opening"],
  ["progression", "Progression"],
  ["climax", "Climax"],
  ["ending", "Ending"],
] as const;

function StateRows({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Record<string, string>;
  onChange: (v: Record<string, string>) => void;
}) {
  const rows = Object.entries(value);
  const setRow = (i: number, k: string, v: string) =>
    onChange(Object.fromEntries(rows.map((r, j) => (j === i ? [k, v] : r))));
  return (
    <div>
      <span className="label">{label}</span>
      <div className="space-y-1">
        {rows.map(([k, v], i) => (
          <div key={i} className="flex gap-1">
            <input
              className="input w-40"
              value={k}
              placeholder="subject"
              aria-label="State subject"
              onChange={(e) => setRow(i, e.target.value, v)}
            />
            <input
              className="input"
              value={v}
              placeholder="state"
              aria-label="State value"
              onChange={(e) => setRow(i, k, e.target.value)}
            />
            <button
              type="button"
              className="btn-ghost"
              aria-label="Remove state"
              onClick={() => onChange(Object.fromEntries(rows.filter((_, j) => j !== i)))}
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => onChange({ ...value, [`subject ${rows.length + 1}`]: "" })}
        >
          <Plus className="size-3" /> Add state
        </button>
      </div>
    </div>
  );
}

export function SceneEditor({
  scene,
  locations,
  cast,
  onChanged,
  projectId,
}: {
  projectId?: string;
  scene: Scene;
  locations: Option[];
  cast: Option[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState(scene);
  const [beats, setBeats] = useState(scene.beats.map((b) => b.description));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useAction(
    async () => {
      const { beats: _b, id, projectId, chapterId, order, createdAt, updatedAt, ...body } = s;
      await patch(`/scenes/${id}`, body);
      await put(`/scenes/${id}/beats`, { beats: beats.filter((b) => b.trim()) });
    },
    { success: "Scene saved", onSuccess: onChanged },
  );
  const remove = useAction(() => del(`/scenes/${scene.id}`), { success: "Scene deleted", onSuccess: onChanged });
  const text = (k: keyof Scene, label: string, multiline = false) => {
    const common = {
      value: String(s[k] ?? ""),
      onChange: (e: { target: { value: string } }) => setS({ ...s, [k]: e.target.value }),
    };
    return multiline ? (
      <label className="block">
        <span className="label">{label}</span>
        <textarea className="input min-h-14" {...common} />
      </label>
    ) : (
      <label className="block">
        <span className="label">{label}</span>
        <input className="input" {...common} />
      </label>
    );
  };

  return (
    <div className="rounded-lg border border-[var(--border)]">
      <div className="flex flex-wrap items-center">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 p-3 text-left"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          <span className="font-medium">
            {scene.order}. {scene.title}
          </span>
          <span className="muted truncate text-xs">
            {[locations.find((l) => l.id === scene.locationId)?.name, scene.time, scene.weather]
              .filter(Boolean)
              .join(" · ")}
          </span>
          <span className="muted ml-auto text-xs">{scene.beats.length} beats</span>
        </button>
        {projectId && (
          <div className="flex max-w-full flex-wrap items-center gap-1 px-2 pb-2 sm:pb-0">
            <BulkGenerateButton
              projectId={projectId}
              scope={{ sceneId: scene.id }}
              label="Generate scene"
              className="btn-secondary px-2 py-1 text-xs"
            />
          </div>
        )}
      </div>
      {open && (
        <div className="space-y-3 border-t border-[var(--border)] p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {text("title", "Title")}
            <label className="block">
              <span className="label">Location</span>
              <select
                className="input"
                value={s.locationId ?? ""}
                onChange={(e) => setS({ ...s, locationId: e.target.value || null })}
              >
                <option value="">None</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
            {text("time", "Time")}
            {text("weather", "Weather")}
          </div>
          {text("summary", "Summary", true)}
          <div>
            <span className="label">Characters present</span>
            <div className="flex flex-wrap gap-1">
              {cast.map((c) => {
                const on = s.characterIds.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    aria-pressed={on}
                    className={`chip border ${on ? "border-accent-500 bg-accent-500/15" : "border-[var(--border)]"}`}
                    onClick={() =>
                      setS({
                        ...s,
                        characterIds: on ? s.characterIds.filter((x) => x !== c.id) : [...s.characterIds, c.id],
                      })
                    }
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {TEXT_FIELDS.map(([k, l]) => (
              <div key={k}>{text(k, l, true)}</div>
            ))}
          </div>
          <div>
            <span className="label">Continuity notes</span>
            <TagInput
              value={s.continuityNotes}
              onChange={(v) => setS({ ...s, continuityNotes: v })}
              placeholder="coat removed, rain started…"
            />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <StateRows label="Initial state" value={s.initialState} onChange={(v) => setS({ ...s, initialState: v })} />
            <StateRows label="Final state" value={s.finalState} onChange={(v) => setS({ ...s, finalState: v })} />
          </div>
          <div>
            <span className="label">Continuity deltas</span>
            <TagInput value={s.continuityDeltas} onChange={(v) => setS({ ...s, continuityDeltas: v })} />
          </div>
          <div>
            <span className="label">Beats</span>
            <div className="space-y-1">
              {beats.map((b, i) => (
                <div key={i} className="flex gap-1">
                  <span className="muted w-6 pt-1.5 text-right text-xs">{i + 1}.</span>
                  <input
                    className="input"
                    value={b}
                    aria-label={`Beat ${i + 1}`}
                    onChange={(e) => setBeats(beats.map((x, j) => (j === i ? e.target.value : x)))}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    aria-label="Remove beat"
                    onClick={() => setBeats(beats.filter((_, j) => j !== i))}
                  >
                    <X className="size-4" />
                  </button>
                </div>
              ))}
              <button type="button" className="btn-ghost text-xs" onClick={() => setBeats([...beats, ""])}>
                <Plus className="size-3" /> Add beat
              </button>
            </div>
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
              Save scene
            </button>
            <button type="button" className="btn-ghost ml-auto text-red-500" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-4" /> Delete
            </button>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete scene?"
        danger
        confirmLabel="Delete"
        busy={remove.isPending}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => remove.mutate()}
      >
        Pages and panels keep existing but lose their scene link.
      </ConfirmDialog>
    </div>
  );
}
