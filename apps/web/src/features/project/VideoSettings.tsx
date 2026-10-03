import type { ProjectSettings, VideoCard, VideoWatermark } from "@openmanga/schemas";
import { ImagePlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, assetUrl } from "../../api/client.ts";
import { clsx, Field, Spinner, TagInput, toast } from "../../components/ui.tsx";

type Video = NonNullable<ProjectSettings["video"]>;

const CORNERS: [VideoWatermark["corner"], string][] = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
];

/**
 * Video settings, applied to every render and shown in the preview: scene-break fades, a logo watermark, intro and
 * outro cards, and the shape and resolution exports default to. A project's, or a channel profile's: `logoUpload`
 * is where a new logo goes (the project's own files, or the account's for a profile).
 */
export function VideoSection({
  logoUpload,
  projectTitle,
  value,
  onChange,
}: {
  logoUpload: string;
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
      const r = await api<{ asset: { id: string } }>(logoUpload, {
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

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Export frame"
          hint="What a video export uses unless you choose otherwise. Shorts are always 9:16."
        >
          <select
            className="input"
            value={v.output?.aspect ?? "16:9"}
            onChange={(e) => set({ output: { height: 1080, ...v.output, aspect: e.target.value as Output["aspect"] } })}
          >
            <option value="16:9">16:9 landscape</option>
            <option value="9:16">9:16 vertical</option>
            <option value="1:1">1:1 square</option>
          </select>
        </Field>
        <Field label="Export resolution">
          <select
            className="input"
            value={v.output?.height ?? 1080}
            onChange={(e) =>
              set({ output: { aspect: "16:9", ...v.output, height: Number(e.target.value) as Output["height"] } })
            }
          >
            <option value={720}>720p</option>
            <option value={1080}>1080p</option>
            <option value={1440}>1440p</option>
          </select>
        </Field>
      </div>
    </section>
  );
}
type Output = NonNullable<Video["output"]>;

type Publishing = Pick<ProjectSettings, "thumbnailStyle" | "youtubeRules">;
type Rules = NonNullable<ProjectSettings["youtubeRules"]>;

/** Thumbnail layout and the channel's rules for the YouTube package text: a project's, or a channel profile's. */
export function PublishingSection({ value, onChange }: { value: Publishing; onChange: (v: Publishing) => void }) {
  const rules: Rules = { titleRules: "", descriptionTemplate: "", tags: [], ...value.youtubeRules };
  const setRules = (p: Partial<Rules>) => onChange({ ...value, youtubeRules: { ...rules, ...p } });
  return (
    <section className="card space-y-3 p-4">
      <div>
        <h2 className="font-medium">Thumbnail & YouTube text</h2>
        <p className="muted text-xs">
          The YouTube package text job follows these rules as your own instructions. Your tags are added to every
          package as written.
        </p>
      </div>
      <Field label="Thumbnail headline side" hint="New thumbnails keep this side of the art clear for the headline.">
        <select
          className="input"
          value={value.thumbnailStyle?.side ?? "left"}
          onChange={(e) => onChange({ ...value, thumbnailStyle: { side: e.target.value as "left" | "right" } })}
        >
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </Field>
      <Field label="Title rules">
        <textarea
          className="input min-h-16"
          maxLength={1000}
          placeholder="e.g. Start with the main character's name. No question marks. Under 60 characters."
          value={rules.titleRules}
          onChange={(e) => setRules({ titleRules: e.target.value })}
        />
      </Field>
      <Field
        label="Description template"
        hint="{title} and {author} are filled in exactly; the model writes {hook} (two lines) and {summary} (no spoilers). Other text stays as written. Chapter timestamps are added after it."
      >
        <textarea
          className="input min-h-24 font-mono text-sm"
          maxLength={4000}
          placeholder={"{hook}\n\n{summary}\n\nNew recaps every Friday."}
          value={rules.descriptionTemplate}
          onChange={(e) => setRules({ descriptionTemplate: e.target.value })}
        />
      </Field>
      <Field label="Default tags" hint="Enter or comma after each.">
        <TagInput value={rules.tags} onChange={(tags) => setRules({ tags: tags.slice(0, 30) })} />
      </Field>
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
