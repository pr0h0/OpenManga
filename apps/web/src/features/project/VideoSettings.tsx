import type { ProjectSettings, VideoCard, VideoWatermark } from "@openmanga/schemas";
import { ImagePlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, assetUrl } from "../../api/client.ts";
import { clsx, Field, Spinner, toast } from "../../components/ui.tsx";

type Video = NonNullable<ProjectSettings["video"]>;

const CORNERS: [VideoWatermark["corner"], string][] = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
];

/**
 * Project video settings, applied to every render and shown in the preview: scene-break fades, a logo watermark,
 * and intro and outro cards.
 */
export function VideoSection({
  projectId,
  projectTitle,
  value,
  onChange,
}: {
  projectId: string;
  projectTitle: string;
  value: ProjectSettings["video"];
  onChange: (v: Video) => void;
}) {
  const v: Video = { fadeAtSceneBreaks: false, ...value };
  const set = (patch: Partial<Video>) => onChange({ ...v, ...patch });
  const wm = v.watermark ?? null;
  const [uploading, setUploading] = useState(false);
  const upload = async (file: File) => {
    setUploading(true);
    try {
      const form = new FormData();
      form.set("file", file);
      const r = await api<{ asset: { id: string } }>(`/projects/${projectId}/video-logo`, {
        method: "POST",
        body: form,
      });
      set({ watermark: { corner: "bottom-right", opacity: 0.8, size: 0.12, ...wm, assetId: r.asset.id } });
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };
  return (
    <section className="card space-y-4 p-4">
      <div>
        <h2 className="font-medium">Video</h2>
        <p className="muted text-xs">Applied to every video export and shown in the preview.</p>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={v.fadeAtSceneBreaks}
          onChange={(e) => set({ fadeAtSceneBreaks: e.target.checked })}
        />
        <span>
          Fade to black at scene breaks
          <span className="muted block text-xs">
            Half a second out and in where the scene changes. A panel's Video shot settings can force a fade or a hard
            cut on its own.
          </span>
        </span>
      </label>

      <div className="space-y-2">
        <div className="label">Logo watermark</div>
        <div className="flex flex-wrap items-center gap-2">
          {wm && (
            <img
              src={assetUrl(wm.assetId)}
              alt="Watermark logo"
              className="h-12 max-w-32 rounded border border-[var(--border)] bg-[var(--panel-2)] object-contain p-1"
            />
          )}
          <label className={clsx("btn-secondary cursor-pointer", uploading && "pointer-events-none opacity-50")}>
            {uploading ? <Spinner /> : <ImagePlus className="size-4" />} {wm ? "Replace logo" : "Upload logo"}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = "";
                if (f) void upload(f);
              }}
            />
          </label>
          {wm && (
            <button type="button" className="btn-ghost text-red-500" onClick={() => set({ watermark: null })}>
              <Trash2 className="size-4" /> Remove
            </button>
          )}
        </div>
        {wm && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Corner">
              <select
                className="input"
                value={wm.corner}
                onChange={(e) => set({ watermark: { ...wm, corner: e.target.value as VideoWatermark["corner"] } })}
              >
                {CORNERS.map(([c, label]) => (
                  <option key={c} value={c}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Opacity ${Math.round(wm.opacity * 100)}%`}>
              <input
                type="range"
                className="w-full"
                min={0.05}
                max={1}
                step={0.05}
                value={wm.opacity}
                onChange={(e) => set({ watermark: { ...wm, opacity: Number(e.target.value) } })}
              />
            </Field>
            <Field label={`Size ${Math.round(wm.size * 100)}% of the width`}>
              <input
                type="range"
                className="w-full"
                min={0.03}
                max={0.4}
                step={0.01}
                value={wm.size}
                onChange={(e) => set({ watermark: { ...wm, size: Number(e.target.value) } })}
              />
            </Field>
          </div>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <CardFields
          label="Intro card"
          value={v.intro ?? null}
          fallbackTitle={projectTitle}
          onChange={(intro) => set({ intro })}
        />
        <CardFields label="Outro card" value={v.outro ?? null} fallbackTitle="" onChange={(outro) => set({ outro })} />
      </div>
    </section>
  );
}

/** One title card: on or off, its title and subtitle over the project's art, and how long it holds. */
function CardFields({
  label,
  value,
  fallbackTitle,
  onChange,
}: {
  label: string;
  value: VideoCard | null;
  fallbackTitle: string;
  onChange: (v: VideoCard | null) => void;
}) {
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked ? { title: fallbackTitle, subtitle: "", durationMs: 3000 } : null)}
        />
        {label}
      </label>
      {value && (
        <>
          <input
            className="input"
            maxLength={120}
            placeholder="Title"
            aria-label={`${label} title`}
            value={value.title}
            onChange={(e) => onChange({ ...value, title: e.target.value })}
          />
          <input
            className="input"
            maxLength={200}
            placeholder="Subtitle (optional)"
            aria-label={`${label} subtitle`}
            value={value.subtitle}
            onChange={(e) => onChange({ ...value, subtitle: e.target.value })}
          />
          <Field label="Seconds on screen">
            <input
              className="input"
              type="number"
              min={1}
              max={15}
              step={0.5}
              value={value.durationMs / 1000}
              onChange={(e) =>
                e.target.value !== "" &&
                onChange({
                  ...value,
                  durationMs: Math.min(15_000, Math.max(1000, Math.round(Number(e.target.value) * 1000))),
                })
              }
            />
          </Field>
        </>
      )}
    </div>
  );
}
