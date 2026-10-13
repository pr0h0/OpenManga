import {
  clipDuration,
  clipPlan,
  clipResolution,
  estimateClipUsd,
  LOCAL_VIDEO_MODEL,
  MAX_SHOT_SECONDS,
  providerCatalog,
  type VideoModel,
  type VideoResolution,
} from "@openmanga/domain/browser";
import type { OnScreenText, ShotVideo } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clapperboard, Trash2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get, patch, post } from "../../../api/client.ts";
import { qk, useAction } from "../../../api/hooks.ts";
import { Field, fmt, StatusChip } from "../../../components/ui.tsx";

type Clip = {
  assetId: string;
  createdAt: string;
  durationMs: number | null;
  provider: string | null;
  model: string | null;
  seconds: number | null;
  parts: number;
  resolution: string | null;
  audio: boolean;
  costUsd: number;
};
type ClipJob = { jobId: string; status: string; model: string | null; failureReason: string | null };
type Clips = {
  activeAssetId: string | null;
  clipPrompt: string | null;
  clipAudio: "mute" | "mix";
  hasArt: boolean;
  clips: Clip[];
  jobs: ClipJob[];
  prompt: string;
};
export type VideoModels = {
  models: (VideoModel & { usable: boolean })[];
  credentials: { id: string; kind: string; label: string }[];
};

const RUNNING = ["queued", "processing", "submitted"];

export const useVideoModels = () =>
  useQuery({ queryKey: ["video-models"], queryFn: () => get<VideoModels>("/video-models"), staleTime: 60_000 });

/** A model option's label: its name and what 5 s cost at the chosen resolution, or why it cannot run yet. */
export function modelLabel(m: VideoModel & { usable: boolean }, resolution: VideoResolution) {
  const usd = estimateClipUsd(m, clipDuration(m, 5), clipResolution(m, resolution), false);
  const price = m.provider === "local" ? "free" : `${fmt.usd(usd)} / ${clipDuration(m, 5)} s`;
  const key = providerCatalog(m.provider)?.label.replace(/ \(.*\)$/, "") ?? m.provider;
  return `${m.label} — ${price}${m.usable ? "" : ` (add a ${m.provider === "fal" ? "fal" : key} key)`}`;
}

/**
 * The shot as a video clip: made from its artwork by a video model (the free still-motion model on every server, or a
 * paid one with your key for its provider, priced before it runs), compared, picked, or set aside for the still. Also what the
 * shot's clip does with its own sound, and text drawn over the shot in videos.
 */
export function ClipPanel({
  panelId,
  video,
  locked,
  invalidate,
}: {
  panelId: string;
  video: Partial<ShotVideo> | null;
  locked: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const qc = useQueryClient();
  const key = [...qk.panel(panelId), "clips"];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<Clips>(`/panels/${panelId}/clips`),
    refetchInterval: (r) => (r.state.data?.jobs.some((j) => RUNNING.includes(j.status)) ? 3000 : false),
  });
  const models = useVideoModels();
  const [model, setModel] = useState(LOCAL_VIDEO_MODEL);
  const [compareWith, setCompareWith] = useState("");
  const [seconds, setSeconds] = useState(5);
  const [partSeconds, setPartSeconds] = useState<number | null>(null);
  const [partNotes, setPartNotes] = useState<string[]>([]);
  const [resolution, setResolution] = useState<VideoResolution>("720p");
  const [audio, setAudio] = useState(false);
  const all = models.data?.models ?? [];
  const m = all.find((x) => x.id === model);
  const credentialFor = (id: string) => {
    const mm = all.find((x) => x.id === id);
    return mm?.provider === "local"
      ? null
      : (models.data?.credentials.find((c) => c.kind === mm?.provider)?.id ?? null);
  };
  const runs = [model, compareWith].filter(Boolean).map((id) => ({ model: id, credentialId: credentialFor(id) }));
  const estimate = runs.reduce((n, r) => {
    const mm = all.find((x) => x.id === r.model);
    return mm
      ? n +
          clipPlan(mm, seconds, partSeconds).parts *
            estimateClipUsd(
              mm,
              clipPlan(mm, seconds, partSeconds).part,
              clipResolution(mm, resolution),
              audio && mm.audio,
            )
      : n;
  }, 0);
  const done = () => {
    void qc.invalidateQueries({ queryKey: key });
    for (const k of invalidate) void qc.invalidateQueries({ queryKey: k });
  };
  const plan = m ? clipPlan(m, seconds, partSeconds) : null;
  const generate = useAction(
    () =>
      post(`/panels/${panelId}/clips`, {
        runs,
        seconds,
        resolution,
        audio,
        partSeconds,
        // Every part, blank ones as "" (they carry the action on).
        parts: plan && plan.parts > 1 ? Array.from({ length: plan.parts }, (_, k) => partNotes[k] ?? "") : undefined,
      }),
    {
      onSuccess: done,
      success: runs.length > 1 ? "Making a clip with each model" : "Making the clip",
    },
  );
  const use = useAction((assetId: string | null) => post(`/panels/${panelId}/clips/use`, { assetId }), {
    onSuccess: done,
    success: (r) =>
      (r as { activeAssetId: string | null }).activeAssetId ? "This shot plays that clip" : "Back to the still",
  });
  const remove = useAction((assetId: string) => del(`/clips/${assetId}`), { onSuccess: done, success: "Clip trashed" });
  const setVideo = useAction((v: Partial<ShotVideo>) => patch(`/panels/${panelId}`, { video: v }), {
    onSuccess: done,
  });
  const data = q.data;
  const active = data?.clips.find((c) => c.assetId === data.activeAssetId) ?? null;
  const text = video?.onScreenText ?? null;
  const setText = (t: Partial<OnScreenText> | null) =>
    setVideo.mutate({
      onScreenText:
        t === null || (t.text ?? text?.text ?? "").trim() === "" ? null : ({ ...text, ...t } as OnScreenText),
    });
  return (
    <details className="rounded-lg border border-[var(--border)] p-2">
      <summary className="cursor-pointer text-sm font-medium">
        <Clapperboard className="mr-1 inline size-3.5" />
        Video clip{active ? " · playing a clip" : ""}
      </summary>
      <fieldset disabled={locked} className="mt-2 space-y-2 text-xs">
        <p className="muted">
          Turn this shot into a moving clip. Videos then play it in place of the still and its camera move. Still motion
          is free; paid models run on your key for their provider and are priced before they start.
        </p>
        {active && (
          <video
            key={active.assetId}
            src={assetUrl(active.assetId)}
            className="w-full rounded bg-black"
            controls
            muted
            loop
            playsInline
            aria-label="This shot's clip"
          />
        )}
        <Field label="Model">
          <select
            className="input text-xs"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            aria-label="Video model"
          >
            {all.map((x) => (
              <option key={x.id} value={x.id} disabled={!x.usable}>
                {modelLabel(x, resolution)}
              </option>
            ))}
          </select>
        </Field>
        {m && <p className="muted">{m.note}</p>}
        <div className="grid grid-cols-3 gap-1.5">
          <Field label="Length (s)">
            <input
              className="input text-xs"
              type="number"
              min={1}
              max={MAX_SHOT_SECONDS}
              value={seconds}
              onChange={(e) => setSeconds(Math.max(1, Math.min(MAX_SHOT_SECONDS, Number(e.target.value) || 5)))}
            />
          </Field>
          <Field label="Resolution">
            <select
              className="input text-xs"
              value={resolution}
              onChange={(e) => setResolution(e.target.value as VideoResolution)}
            >
              <option value="480p">480p</option>
              <option value="720p">720p</option>
              <option value="1080p">1080p</option>
            </select>
          </Field>
          <Field label="Compare with">
            <select
              className="input text-xs"
              value={compareWith}
              onChange={(e) => setCompareWith(e.target.value)}
              aria-label="Compare with model"
            >
              <option value="">—</option>
              {all
                .filter((x) => x.id !== model)
                .map((x) => (
                  <option key={x.id} value={x.id} disabled={!x.usable}>
                    {x.label}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {m && (plan?.parts ?? 1) > 1 && (
          <div className="space-y-1.5 rounded border border-[var(--border)] p-1.5">
            <div className="flex items-center gap-2">
              <span>
                Made as <strong>{plan!.parts} parts</strong> of {plan!.part} s, each continuing from the last frame of
                the one before
              </span>
              <select
                className="input ml-auto w-auto py-0.5 text-xs"
                aria-label="Part length"
                value={partSeconds ?? ""}
                onChange={(e) => setPartSeconds(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Longest ({Math.max(...m.durations)} s)</option>
                {m.durations.map((d) => (
                  <option key={d} value={d}>
                    {d} s parts
                  </option>
                ))}
              </select>
            </div>
            {Array.from({ length: plan!.parts }, (_, k) => (
              <input
                key={k}
                className="input text-xs"
                aria-label={`Part ${k + 1}`}
                placeholder={`${k * plan!.part}–${(k + 1) * plan!.part} s: ${k === 0 ? "how it starts" : k === plan!.parts - 1 ? "how it ends" : "what happens next"} (blank carries the action on)`}
                maxLength={600}
                value={partNotes[k] ?? ""}
                onChange={(e) =>
                  setPartNotes((n) => {
                    const next = [...n];
                    next[k] = e.target.value;
                    return next;
                  })
                }
              />
            ))}
          </div>
        )}
        {m?.audio && (
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={audio} onChange={(e) => setAudio(e.target.checked)} />
            Generate sound with the picture (costs more)
          </label>
        )}
        <Field label="What moves" hint="Blank: written from the shot's beat and directing.">
          <textarea
            key={`${panelId}-${data?.clipPrompt ?? ""}`}
            className="input min-h-14 text-xs"
            placeholder="e.g. she turns to the window; curtains drift; slow push in"
            defaultValue={data?.clipPrompt ?? ""}
            onBlur={(e) => {
              const v = e.target.value.trim() || null;
              if (v !== (data?.clipPrompt ?? null)) setVideo.mutate({ clipPrompt: v });
            }}
          />
        </Field>
        <div className="flex items-center gap-2">
          <span className="muted">
            {plan && `${plan.total} s at ${clipResolution(m!, resolution)}`}
            {runs.length > 1 ? " each" : ""} · {estimate ? `~${fmt.usd(estimate)}` : "free"}
          </span>
          <button
            type="button"
            className="btn-primary ml-auto px-2 py-1 text-xs"
            disabled={
              generate.isPending || !data?.hasArt || runs.some((r) => !all.find((x) => x.id === r.model)?.usable)
            }
            title={data?.hasArt ? undefined : "Draw the shot first"}
            onClick={() => generate.mutate()}
          >
            {runs.length > 1 ? "Make both" : "Make clip"}
          </button>
        </div>
        {!data?.hasArt && <p className="text-amber-600">Draw the shot first: clips are made from its image.</p>}
        {data?.jobs
          .filter((j) => RUNNING.includes(j.status) || j.status === "failed")
          .slice(0, 4)
          .map((j) => (
            <div key={j.jobId} className="flex items-center gap-2">
              <StatusChip status={j.status} />
              <span className="truncate">{all.find((x) => x.id === j.model)?.label ?? j.model}</span>
              {j.failureReason && <span className="truncate text-red-500">{j.failureReason}</span>}
            </div>
          ))}
        {Boolean(data?.clips.length) && (
          <ul className="space-y-1" aria-label="Clips">
            {data!.clips.map((c) => (
              <li key={c.assetId} className="flex items-center gap-1.5 rounded border border-[var(--border)] p-1">
                <video
                  src={assetUrl(c.assetId)}
                  className="h-10 w-16 rounded bg-black object-cover"
                  muted
                  playsInline
                  preload="metadata"
                  onMouseEnter={(e) => void e.currentTarget.play().catch(() => {})}
                  onMouseLeave={(e) => e.currentTarget.pause()}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {all.find((x) => x.id === c.model)?.label ?? c.model}
                    {c.assetId === data!.activeAssetId && " · playing"}
                  </div>
                  <div className="muted">
                    {c.durationMs ? `${(c.durationMs / 1000).toFixed(1)} s` : ""}
                    {c.parts > 1 ? ` in ${c.parts} parts` : ""} · {c.resolution} ·{" "}
                    {c.costUsd ? fmt.usd(c.costUsd) : "free"}
                  </div>
                </div>
                {c.assetId !== data!.activeAssetId && (
                  <button
                    type="button"
                    className="btn-secondary px-2 py-0.5 text-xs"
                    onClick={() => use.mutate(c.assetId)}
                  >
                    Use
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost p-1"
                  aria-label="Trash clip"
                  onClick={() => remove.mutate(c.assetId)}
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {active && (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => use.mutate(null)}>
              Use the still instead
            </button>
            {active.audio && (
              <label className="flex items-center gap-1">
                Clip sound
                <select
                  className="input py-0.5 text-xs"
                  value={data!.clipAudio}
                  onChange={(e) => setVideo.mutate({ clipAudio: e.target.value as "mute" | "mix" })}
                >
                  <option value="mute">Off</option>
                  <option value="mix">Under the narration</option>
                </select>
              </label>
            )}
          </div>
        )}
        <Field label="Text on screen" hint="Shown over this shot for its whole hold (an ad's offer or call to action).">
          <input
            key={`${panelId}-${text?.text ?? ""}`}
            className="input text-xs"
            placeholder="e.g. 30% OFF — TODAY ONLY"
            maxLength={200}
            defaultValue={text?.text ?? ""}
            onBlur={(e) => {
              if (e.target.value.trim() !== (text?.text ?? "")) setText({ text: e.target.value.trim() });
            }}
          />
        </Field>
        {text && (
          <div className="grid grid-cols-2 gap-1.5">
            <select
              className="input text-xs"
              aria-label="Text position"
              value={text.position}
              onChange={(e) => setText({ position: e.target.value as OnScreenText["position"] })}
            >
              <option value="top">Top</option>
              <option value="center">Middle</option>
              <option value="bottom">Bottom</option>
            </select>
            <select
              className="input text-xs"
              aria-label="Text style"
              value={text.style}
              onChange={(e) => setText({ style: e.target.value as OnScreenText["style"] })}
            >
              <option value="headline">Headline</option>
              <option value="caption">Caption</option>
              <option value="cta">Call to action (boxed)</option>
            </select>
          </div>
        )}
      </fieldset>
    </details>
  );
}
