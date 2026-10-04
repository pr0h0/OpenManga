import {
  captionsSupported,
  SHORTS_LIMIT_MS,
  SHORTS_MIN_MS,
  shortsLengthWarning,
  type VideoAspect,
  YOUTUBE_SHORTS_MAX_MS,
} from "@openmanga/domain/browser";
import type { ShortsCaptions } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useEffect } from "react";
import { assetUrl, get } from "../../api/client.ts";
import { clsx, ErrorBox, Field, Spinner } from "../../components/ui.tsx";
import { PreviewVideoButton } from "../video/VideoPreview.tsx";

type Candidate = {
  id: string;
  label: string;
  shotType: string;
  artAssetId: string | null;
  hasArt: boolean;
  text: string;
  holdMs: number;
  score: number;
  picked: boolean;
};

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/**
 * The shots of a Shorts cut and its length: the automatic pick (dramatic shots spread across the story, filling up to
 * the length, 3 minutes by default), which the user can change before previewing and rendering. `value` is the chosen
 * panel ids; the render plays them in story order and stops before the shot that would pass the length.
 */
/** Captions drawn into a Shorts cut, from its narration. */
const CAPTION_OPTIONS: { value: ShortsCaptions; label: string }[] = [
  { value: "off", label: "Off (.srt file only)" },
  { value: "bottom", label: "Clean, at the bottom" },
  { value: "center", label: "Large, in the centre" },
  { value: "two_line", label: "Two lines, at the bottom" },
];

/** The captions a Shorts cut gets; off, and not offered, for a narration language the render has no font for. */
export function CaptionsField({
  value,
  onChange,
  language,
}: {
  value: ShortsCaptions;
  onChange: (v: ShortsCaptions) => void;
  language: string;
}) {
  const ok = captionsSupported(language);
  return (
    <Field
      label="Captions"
      hint={ok ? undefined : "Not available for this narration language yet: the render has no font for its script."}
    >
      <select
        className="input"
        value={ok ? value : "off"}
        disabled={!ok}
        onChange={(e) => onChange(e.target.value as ShortsCaptions)}
      >
        {CAPTION_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function ShortsPicker({
  projectId,
  chapterId,
  language,
  minHoldMs,
  aspect,
  lengthSeconds,
  onLength,
  value,
  onChange,
}: {
  projectId: string;
  chapterId: string | null;
  language: string;
  minHoldMs: number;
  aspect: VideoAspect;
  lengthSeconds: number;
  onLength: (seconds: number) => void;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const params = new URLSearchParams({
    ...(chapterId ? { chapterId } : {}),
    language,
    minHoldMs: String(minHoldMs),
    lengthSeconds: String(lengthSeconds),
  });
  const q = useQuery({
    queryKey: ["shorts", projectId, params.toString()],
    queryFn: () => get<{ shots: Candidate[] }>(`/projects/${projectId}/shorts?${params}`),
  });
  const candidates = q.data?.shots;
  const auto = () => onChange((candidates ?? []).filter((s) => s.picked).map((s) => s.id));
  // A new candidate list (another chapter, language or minimum hold) starts from its automatic pick.
  useEffect(() => {
    if (candidates) onChange(candidates.filter((s) => s.picked).map((s) => s.id));
  }, [candidates]);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const shots = q.data?.shots ?? [];
  const chosen = new Set(value);
  const total = shots.filter((s) => chosen.has(s.id)).reduce((n, s) => n + s.holdMs, 0);
  const maxMs = lengthSeconds * 1000;
  // The render stops before the shot that would pass the length, so the film is at most that long.
  const warning = shortsLengthWarning(Math.min(total, maxMs));
  const toggle = (id: string) => onChange(chosen.has(id) ? value.filter((x) => x !== id) : [...value, id]);
  const tone =
    total > maxMs
      ? "text-amber-600 dark:text-amber-400"
      : total < SHORTS_MIN_MS
        ? "muted"
        : "text-emerald-600 dark:text-emerald-400";
  return (
    <div className="space-y-2">
      <Field
        label="Length (seconds)"
        hint={`The pick fills up to this; ${YOUTUBE_SHORTS_MAX_MS / 1000} s is YouTube's Shorts limit.`}
      >
        <input
          className="input"
          type="number"
          min={SHORTS_MIN_MS / 1000}
          max={SHORTS_LIMIT_MS / 1000}
          step={15}
          defaultValue={lengthSeconds}
          onBlur={(e) => {
            const n = Math.round(Number(e.target.value));
            const v = Math.min(SHORTS_LIMIT_MS / 1000, Math.max(SHORTS_MIN_MS / 1000, n || lengthSeconds));
            e.target.value = String(v);
            if (v !== lengthSeconds) onLength(v);
          }}
        />
      </Field>
      {warning && (
        <p role="alert" className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          {warning}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={clsx("font-medium tabular-nums", tone)}>
          {value.length} shot(s) · {secs(total)}
        </span>
        <span className="muted">
          {total > maxMs
            ? `Over ${secs(maxMs)}: the render stops before the shot that passes it.`
            : total < SHORTS_MIN_MS
              ? "Under 30 s: add a few shots."
              : `Within 30 s – ${secs(maxMs)}.`}
        </span>
        <button type="button" className="btn-ghost ml-auto py-0.5 text-xs" onClick={auto}>
          <Wand2 className="size-3.5" /> Auto-pick
        </button>
      </div>
      <ul className="max-h-72 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] text-xs">
        {shots.map((s) => (
          <li key={s.id}>
            <label
              className={clsx(
                "flex cursor-pointer items-center gap-2 p-1.5 hover:bg-[var(--panel-2)]",
                !s.hasArt && "opacity-50",
              )}
            >
              <input type="checkbox" checked={chosen.has(s.id)} disabled={!s.hasArt} onChange={() => toggle(s.id)} />
              {s.artAssetId ? (
                <img
                  src={assetUrl(s.artAssetId, "thumbnail")}
                  alt=""
                  className="size-10 shrink-0 rounded object-cover"
                />
              ) : (
                <span className="size-10 shrink-0 rounded bg-[var(--panel-2)]" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {s.label} · {s.shotType}
                </span>
                <span className="muted block truncate" title={s.text || undefined}>
                  {s.hasArt ? s.text || "— no narration —" : "No artwork"}
                </span>
              </span>
              <span className="muted shrink-0 tabular-nums">{secs(s.holdMs)}</span>
            </label>
          </li>
        ))}
      </ul>
      {value.length > 0 && (
        <PreviewVideoButton
          projectId={projectId}
          scope={{ panelIds: shots.filter((s) => chosen.has(s.id)).map((s) => s.id) }}
          label="Preview the Short"
          title="Preview — Shorts cut"
          className="btn-secondary w-full"
          defaultAspect={aspect}
          defaultMinHoldMs={minHoldMs}
          capMs={maxMs}
        />
      )}
    </div>
  );
}
