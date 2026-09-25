import { NARRATION_LANGUAGES, voiceMatchesLanguage } from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, Download, Mic, Plus, Volume2, Wand2 } from "lucide-react";
import { useState } from "react";
import { api, get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ChapterListItem, NarrationDoc, PanelRow, TtsStatus } from "../../api/types.ts";
import { ConfirmDialog, EmptyState, ErrorBox, Field, PageHeader, Spinner, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { JsonBlock } from "../generation/shared.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";
import { ChapterPlayer } from "./ChapterPlayer.tsx";
import { LineEditor } from "./LineEditor.tsx";
import { SynthesisProgress } from "./SynthesisProgress.tsx";

function TtsBanner({ status }: { status: TtsStatus | undefined }) {
  if (!status) return null;
  const s = status.status.state;
  const ok = status.enabled && status.status.ok;
  const msg = !status.enabled
    ? "Narration synthesis is disabled on this server (TTS_ENABLED=false). You can still write narration."
    : ok
      ? `Local Kokoro TTS is ready (${status.provider}). Synthesis costs $0 in external API fees.`
      : s === "loading"
        ? "Kokoro is still loading its model. Synthesis requests will wait and retry."
        : "Kokoro is offline. Queued synthesis will retry; check the kokoro container.";
  return (
    <div
      className={`mb-4 flex items-start gap-2 rounded-lg border p-3 text-sm ${ok ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"}`}
    >
      {ok ? (
        <CheckCircle2 className="mt-0.5 size-4 text-emerald-500" />
      ) : (
        <AlertTriangle className="mt-0.5 size-4 text-amber-500" />
      )}
      <div>
        {msg}
        {status.status.detail && !ok && <div className="muted text-xs">{status.status.detail}</div>}
      </div>
    </div>
  );
}

export function NarrationPage() {
  const projectId = useProjectId();
  const { data: overview } = useProject();
  const search = useSearch({ strict: false }) as { chapterId?: string };
  const navigate = useNavigate();
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const chapterId = search.chapterId ?? chapters.data?.chapters[0]?.id;
  const [language, setLanguage] = useState<string>();
  const lang = language ?? overview?.project.language ?? "en";
  const tts = useQuery({
    queryKey: ["tts-status"],
    queryFn: () => get<TtsStatus>("/tts/status"),
    refetchInterval: (q) => (q.state.data?.status.ok ? 60_000 : 10_000),
  });
  const doc = useQuery({
    queryKey: [...qk.narration(chapterId ?? ""), lang],
    queryFn: () => get<NarrationDoc>(`/chapters/${chapterId}/narration?language=${encodeURIComponent(lang)}`),
    enabled: Boolean(chapterId),
  });
  const panels = useQuery({
    queryKey: ["chapter", chapterId, "panels"],
    queryFn: () => get<{ panels: (PanelRow & { pageOrder: number })[] }>(`/chapters/${chapterId}/panels`),
    enabled: Boolean(chapterId),
  });
  const [showTimeline, setShowTimeline] = useState(false);
  const timeline = useQuery({
    queryKey: ["chapter", chapterId, "timeline", lang],
    queryFn: () => get<unknown>(`/chapters/${chapterId}/narration/timeline?language=${encodeURIComponent(lang)}`),
    enabled: Boolean(chapterId) && showTimeline,
  });

  const settings = overview?.project.settings;
  const [voice, setVoice] = useState<string>();
  const [speed, setSpeed] = useState<number>();
  const curVoice = voice ?? settings?.narrationVoice ?? "af_heart";
  const curSpeed = speed ?? settings?.narrationSpeed ?? 1;
  const invalidate = [qk.narration(chapterId ?? "")] as const;

  const saveDefaults = useAction(
    (s: { narrationVoice?: string; narrationSpeed?: number; narrationStyle?: string }) =>
      patch(`/projects/${projectId}`, { settings: s }),
    { invalidate: [qk.project(projectId), ...invalidate], success: "Narration defaults saved" },
  );
  const [style, setStyle] = useState<string>();
  const curStyle = style ?? settings?.narrationStyle ?? "";
  const aiText = useAiBody("text");
  const aiTts = useAiBody("tts");
  const [confirmReplace, setConfirmReplace] = useState(false);
  const generate = useAction(
    (replace: boolean) =>
      post(`/chapters/${chapterId}/narration/generate`, { ...aiText(), style: curStyle, replace, language: lang }),
    { success: "Narration writing queued", onSuccess: () => setConfirmReplace(false) },
  );
  const synthAll = useAction(
    () =>
      post<{ queued: number; total: number }>(`/chapters/${chapterId}/narration/synthesize`, {
        ...aiTts(),
        onlyMissing: true,
        language: lang,
      }),
    {
      invalidate,
      success: (r) =>
        r.queued
          ? `${r.queued} of ${r.total} segments queued for synthesis`
          : "All segments already have current audio",
    },
  );
  const applyPauses = useAction(
    () => post<{ updated: number }>(`/chapters/${chapterId}/narration/pauses`, { language: lang }),
    { invalidate, success: (r) => `Pauses updated on ${r.updated} segment(s)` },
  );
  const cancelSynth = useAction(
    () => post<{ cancelled: number }>(`/chapters/${chapterId}/narration/synthesize/cancel`),
    { invalidate, success: (r) => `Cancelled ${r.cancelled} queued synthesis job(s)` },
  );
  const addLine = useAction(
    () => post(`/chapters/${chapterId}/narration/lines`, { text: "New narration line.", language: lang }),
    {
      invalidate,
    },
  );
  const exportKind = useAction(
    (kind: "narration_audio" | "timeline") =>
      post(`/projects/${projectId}/exports`, {
        kind,
        chapterId,
        language: lang,
        audio: { format: "mp3", normalize: true },
      }),
    { success: "Export queued — it will appear on the Exports page" },
  );
  const [previewing, setPreviewing] = useState(false);
  const [current, setCurrent] = useState<string | null>(null);

  const preview = async () => {
    setPreviewing(true);
    try {
      const res = await api<Response>("/tts/preview", {
        method: "POST",
        body: { voice: curVoice, speed: curSpeed, ...aiTts() },
        raw: true,
      });
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      toast.error(e);
    } finally {
      setPreviewing(false);
    }
  };

  const allSegments = doc.data?.lines.flatMap((l) => l.segments) ?? [];
  const panelOptions = (panels.data?.panels ?? []).map((p) => ({
    id: p.id,
    label: `p${p.pageOrder}·${p.order} ${p.storyBeat.slice(0, 40)}`,
  }));
  const voices = [...(tts.data?.voices ?? [])].sort(
    (a, b) => Number(voiceMatchesLanguage(b.language, lang)) - Number(voiceMatchesLanguage(a.language, lang)),
  );

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title="Narration"
        subtitle="Structured narration text first, then local Kokoro speech."
        actions={
          <select
            className="input w-auto"
            value={chapterId ?? ""}
            onChange={(e) =>
              navigate({
                to: "/projects/$projectId/narration",
                params: { projectId },
                search: { chapterId: e.target.value },
              })
            }
            aria-label="Chapter"
          >
            {chapters.data?.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                Ch. {c.order} — {c.title}
              </option>
            ))}
          </select>
        }
      />
      <SynthesisProgress projectId={projectId} language={lang} />
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          Narration language
          <select className="input w-auto" value={lang} onChange={(e) => setLanguage(e.target.value)}>
            {NARRATION_LANGUAGES.map((l) => {
              const n = doc.data?.tracks?.find((t) => t.language === l.code)?.lines;
              return (
                <option key={l.code} value={l.code}>
                  {l.name}
                  {n ? ` (${n} lines)` : ""}
                </option>
              );
            })}
          </select>
        </label>
        <span className="muted text-xs">
          Each language is its own narration track over the same artwork; write it, then synthesize with a voice for
          that language.
        </span>
      </div>

      <TtsBanner status={tts.data} />
      {!chapters.isLoading && !chapters.data?.chapters.length && (
        <EmptyState icon={<Mic className="size-8" />} title="No chapters yet">
          Create chapters from the Story or Chapters page first.
        </EmptyState>
      )}
      {chapterId && (
        <>
          <div className="card mb-4 grid gap-3 p-4 md:grid-cols-[1fr_1fr_auto]">
            <Field label="Default voice">
              <select
                className="input"
                value={curVoice}
                onChange={(e) => {
                  setVoice(e.target.value);
                  saveDefaults.mutate({ narrationVoice: e.target.value });
                }}
              >
                {!voices.some((v) => v.id === curVoice) && <option value={curVoice}>{curVoice}</option>}
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} · {v.language}
                    {v.gender ? ` · ${v.gender}` : ""}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={`Default speed ×${curSpeed.toFixed(2)}`}>
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={curSpeed}
                onChange={(e) => setSpeed(Number(e.target.value))}
                onMouseUp={() => saveDefaults.mutate({ narrationSpeed: curSpeed })}
                onKeyUp={() => saveDefaults.mutate({ narrationSpeed: curSpeed })}
                className="w-full"
              />
            </Field>
            <div className="flex items-end">
              <button
                type="button"
                className="btn-secondary"
                onClick={preview}
                disabled={previewing || !tts.data?.enabled}
              >
                {previewing ? <Spinner /> : <Volume2 className="size-4" />} Preview voice
              </button>
            </div>
          </div>

          <div className="card mb-4 flex flex-wrap items-end gap-2 p-4">
            <div className="min-w-60 flex-1">
              <Field label="Narration style (saved for every chapter)">
                <input
                  className="input"
                  placeholder="e.g. suspenseful recap, second person"
                  value={curStyle}
                  maxLength={500}
                  onChange={(e) => setStyle(e.target.value)}
                  onBlur={() =>
                    curStyle !== (settings?.narrationStyle ?? "") && saveDefaults.mutate({ narrationStyle: curStyle })
                  }
                />
              </Field>
            </div>
            <AiChip cap="text" />
            <button
              type="button"
              className="btn-secondary"
              onClick={() => generate.mutate(false)}
              disabled={generate.isPending}
            >
              <Wand2 className="size-4" /> Write narration
            </button>
            <button type="button" className="btn-ghost" onClick={() => setConfirmReplace(true)}>
              Regenerate (replace)
            </button>
            <button
              type="button"
              className="btn-ghost"
              title={`Set every pause to ${settings?.narrationPauseMs ?? 350} ms and scene/chapter ends to ${settings?.sceneBreakPauseMs ?? 700} ms (Project settings). Audio is kept.`}
              onClick={() => applyPauses.mutate()}
              disabled={applyPauses.isPending || !allSegments.length}
            >
              Apply pause settings
            </button>
            <AiChip cap="tts" />
            <button
              type="button"
              className="btn-primary"
              onClick={() => synthAll.mutate()}
              disabled={synthAll.isPending || !tts.data?.enabled || !allSegments.length}
            >
              <Mic className="size-4" /> Synthesize all missing
            </button>
            {allSegments.some((sg) => sg.job?.status === "queued") && (
              <button
                type="button"
                className="btn-ghost"
                onClick={() => cancelSynth.mutate()}
                disabled={cancelSynth.isPending}
              >
                Cancel queued synthesis
              </button>
            )}
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <ChapterPlayer segments={allSegments} onCurrent={setCurrent} />
            <div className="flex gap-2">
              <button type="button" className="btn-secondary" onClick={() => exportKind.mutate("narration_audio")}>
                <Download className="size-4" /> Download audio
              </button>
              <Link to="/projects/$projectId/exports" params={{ projectId }} className="btn-ghost">
                Exports →
              </Link>
            </div>
          </div>

          {doc.error && <ErrorBox error={doc.error} onRetry={() => doc.refetch()} />}
          {doc.isLoading ? (
            <Spinner />
          ) : !doc.data?.lines.length ? (
            <EmptyState
              title="No narration yet"
              action={
                <button type="button" className="btn-primary" onClick={() => addLine.mutate()}>
                  <Plus className="size-4" /> Add line
                </button>
              }
            >
              Generate narration with a text model or write it yourself.
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {doc.data.lines.map((l) => (
                <LineEditor
                  key={l.id}
                  line={l}
                  panels={panelOptions}
                  voices={voices}
                  invalidate={invalidate}
                  currentSegmentId={current}
                  defaults={doc.data.defaults}
                />
              ))}
              <button
                type="button"
                className="btn-secondary"
                onClick={() => addLine.mutate()}
                disabled={addLine.isPending}
              >
                <Plus className="size-4" /> Add line
              </button>
            </div>
          )}

          <details className="card mt-4 p-4" onToggle={(e) => setShowTimeline((e.target as HTMLDetailsElement).open)}>
            <summary className="cursor-pointer font-medium">Timeline manifest</summary>
            <p className="muted my-2 text-xs">Machine-readable panel/audio timing for future recap video generation.</p>
            {timeline.isLoading ? <Spinner /> : timeline.data ? <JsonBlock value={timeline.data} /> : null}
            <button type="button" className="btn-secondary mt-2" onClick={() => exportKind.mutate("timeline")}>
              <Download className="size-4" /> Export timeline JSON
            </button>
          </details>
        </>
      )}
      <ConfirmDialog
        open={confirmReplace}
        title="Replace narration?"
        confirmLabel="Replace"
        danger
        busy={generate.isPending}
        onClose={() => setConfirmReplace(false)}
        onConfirm={() => generate.mutate(true)}
      >
        Existing narration lines that are not shown as on-page captions will be deleted and rewritten. Synthesized audio
        for them will no longer be linked.
      </ConfirmDialog>
    </div>
  );
}
