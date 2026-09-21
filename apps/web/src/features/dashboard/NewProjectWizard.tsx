import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeft, ArrowRight, Sparkles } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import type { JobDetail, StoryAnalysisRow, StylePresetRow } from "../../api/types.ts";
import { clsx, ErrorBox, Field, PageHeader, Spinner } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { AnalysisReview } from "../story/AnalysisReview.tsx";

const TYPES = [
  { value: "manhwa", label: "Manhwa" },
  { value: "manga", label: "Manga" },
  { value: "webtoon", label: "Webtoon" },
  { value: "comic", label: "Comic" },
  { value: "illustrated_story", label: "Illustrated story" },
] as const;
const INPUT_KINDS = [
  { value: "story", label: "Story" },
  { value: "chapter", label: "Chapter" },
  { value: "outline", label: "Outline" },
  { value: "screenplay", label: "Screenplay" },
  { value: "idea", label: "Idea" },
] as const;
const STEPS = ["Project", "Story", "Analysis", "Review"];

export function NewProjectWizard() {
  const aiText = useAiBody("text");
  const navigate = useNavigate();
  const qc = useQueryClient();
  const presets = useQuery({
    queryKey: ["style-presets"],
    queryFn: () => get<{ presets: StylePresetRow[] }>("/style-presets"),
  });
  const [step, setStep] = useState(0);
  const [details, setDetails] = useState({
    title: "",
    description: "",
    projectType: "manhwa",
    language: "en",
    readingDirection: "",
    colorMode: "full_color",
    stylePresetKey: "manhwa",
    customStyle: "",
    format: "comic",
  });
  const [story, setStory] = useState({ inputKind: "story", title: "", content: "" });
  const [projectId, setProjectId] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const job = useQuery({
    queryKey: ["job", jobId],
    queryFn: () => get<JobDetail>(`/generations/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) =>
      q.state.data && ["completed", "failed", "cancelled"].includes(q.state.data.job.status) ? false : 1500,
  });
  const analysis = useQuery({
    queryKey: ["analysis", analysisId, job.data?.job.status],
    queryFn: () => get<{ analysis: StoryAnalysisRow }>(`/story-analyses/${analysisId}`),
    enabled: Boolean(analysisId) && job.data?.job.status === "completed",
  });

  const setD = (k: keyof typeof details) => (e: { target: { value: string } }) =>
    setDetails((d) => ({ ...d, [k]: e.target.value }));

  const createAndAnalyze = async (analyze: boolean) => {
    setBusy(true);
    setError(null);
    try {
      let pid = projectId;
      if (!pid) {
        const r = await post<{ project: { id: string } }>("/projects", {
          ...details,
          readingDirection: details.readingDirection || undefined,
          story: story.content.trim()
            ? { content: story.content, inputKind: story.inputKind, title: story.title }
            : undefined,
        });
        pid = r.project.id;
        setProjectId(pid);
        await qc.invalidateQueries({ queryKey: ["projects"] });
      }
      if (!analyze || !story.content.trim()) {
        navigate({ to: "/projects/$projectId", params: { projectId: pid } });
        return;
      }
      const s = await get<{ latest: { id: string } }>(`/projects/${pid}/story`);
      const a = await post<{ job: { id: string }; analysis: { id: string } }>(
        `/story-revisions/${s.latest.id}/analyze`,
        aiText(),
      );
      setJobId(a.job.id);
      setAnalysisId(a.analysis.id);
      setStep(2);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const status = job.data?.job.status;
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="New project"
        subtitle="You can intervene at every stage — nothing is one-click or irreversible."
      />
      <ol className="mb-6 flex flex-wrap gap-2" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={clsx(
              "chip px-3 py-1 text-xs",
              i === step ? "bg-accent-600 text-white" : i < step ? "bg-accent-600/20" : "bg-[var(--panel-2)] muted",
            )}
            aria-current={i === step ? "step" : undefined}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <ErrorBox error={error} />

      {step === 0 && (
        <div className="card space-y-4 p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Title">
              <input
                className="input"
                value={details.title}
                onChange={setD("title")}
                required
                autoFocus
                maxLength={200}
              />
            </Field>
            <Field
              label="Format"
              hint={
                details.format === "film"
                  ? "Every page is one full-frame 16:9 shot, planned as a shot list and exported as a narrated Ken Burns video. Can't be changed once pages exist."
                  : details.format === "vertical"
                    ? "One continuous scrolling column, one full-width panel at a time, with dialogue and captions. You author what happens between panels — a gap, no gap, an overlap or a fade. Can't be changed once pages exist."
                    : "Comic pages with 1–5 panels, lettering and page/PDF/webtoon exports."
              }
            >
              <select className="input" value={details.format} onChange={setD("format")}>
                <option value="comic">Comic pages</option>
                <option value="vertical">Vertical scroll (manhwa strip)</option>
                <option value="film">Narrated video (16:9 shots)</option>
              </select>
            </Field>
            <Field label="Project type">
              <select className="input" value={details.projectType} onChange={setD("projectType")}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Language">
              <input className="input" value={details.language} onChange={setD("language")} maxLength={16} />
            </Field>
            <Field label="Reading direction" hint="Default: manga RTL, webtoon vertical, others LTR">
              <select className="input" value={details.readingDirection} onChange={setD("readingDirection")}>
                <option value="">Default for type</option>
                <option value="ltr">Left to right</option>
                <option value="rtl">Right to left</option>
                <option value="vertical">Vertical scroll</option>
              </select>
            </Field>
            <Field label="Color mode">
              <select className="input" value={details.colorMode} onChange={setD("colorMode")}>
                <option value="full_color">Full color</option>
                <option value="grayscale">Grayscale</option>
                <option value="bw_manga">Black & white manga</option>
              </select>
            </Field>
          </div>
          <Field label="Description">
            <textarea
              className="input min-h-16"
              value={details.description}
              onChange={setD("description")}
              maxLength={5000}
            />
          </Field>
          <div>
            <span className="label">Default art style</span>
            {presets.isLoading && <Spinner />}
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {presets.data?.presets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setDetails((d) => ({ ...d, stylePresetKey: p.key }))}
                  className={clsx(
                    "rounded-lg border p-3 text-left text-sm",
                    details.stylePresetKey === p.key
                      ? "border-accent-500 bg-accent-600/10"
                      : "border-[var(--border)] hover:bg-[var(--panel-2)]",
                  )}
                  aria-pressed={details.stylePresetKey === p.key}
                >
                  <div className="font-medium">{p.name}</div>
                  <div className="muted mt-0.5 line-clamp-2 text-xs">{p.definition.summary}</div>
                </button>
              ))}
            </div>
          </div>
          <Field label="Custom style notes (optional)">
            <textarea
              className="input min-h-14"
              value={details.customStyle}
              onChange={setD("customStyle")}
              placeholder="e.g. muted teal palette, heavy rain atmosphere, thin lineart"
            />
          </Field>
          <div className="flex justify-end">
            <button type="button" className="btn-primary" disabled={!details.title.trim()} onClick={() => setStep(1)}>
              Next <ArrowRight className="size-4" />
            </button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card space-y-4 p-5">
          <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Input kind">
            {INPUT_KINDS.map((k) => (
              // biome-ignore lint/a11y/useSemanticElements: styled segmented control with radio semantics
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={story.inputKind === k.value}
                onClick={() => setStory((s) => ({ ...s, inputKind: k.value }))}
                className={clsx("btn", story.inputKind === k.value ? "bg-accent-600 text-white" : "btn-secondary")}
              >
                {k.label}
              </button>
            ))}
          </div>
          <Field label="Title (optional)">
            <input
              className="input"
              value={story.title}
              onChange={(e) => setStory((s) => ({ ...s, title: e.target.value }))}
            />
          </Field>
          <Field
            label={`Paste your ${story.inputKind}`}
            hint={`${story.content.length.toLocaleString()} characters · stored as revision 1, never overwritten`}
          >
            <textarea
              className="input min-h-80 font-mono text-sm leading-relaxed"
              value={story.content}
              onChange={(e) => setStory((s) => ({ ...s, content: e.target.value }))}
              placeholder="Chapter 1&#10;&#10;Woo Jin climbed onto the rooftop in the rain…"
            />
          </Field>
          <div className="flex flex-wrap justify-between gap-2">
            <button type="button" className="btn-secondary" onClick={() => setStep(0)}>
              <ArrowLeft className="size-4" /> Back
            </button>
            <div className="flex items-center gap-2">
              <AiChip cap="text" />
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => createAndAnalyze(false)}>
                Create without analysis
              </button>
              <button
                type="button"
                className="btn-primary"
                disabled={busy || !story.content.trim()}
                onClick={() => createAndAnalyze(true)}
              >
                {busy ? <Spinner /> : <Sparkles className="size-4" />} Create & analyze
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-4 p-5">
          {(!status || status === "queued" || status === "processing") && (
            <div className="flex items-center gap-3">
              <Spinner className="size-5" />
              <div>
                <div className="font-medium">Analyzing story…</div>
                <div className="muted text-sm">
                  Extracting genre, cast (with alias resolution), world, locations, props, plot beats and chapters.
                  Status: {status ?? "queued"}
                </div>
              </div>
            </div>
          )}
          {status === "failed" && (
            <>
              <ErrorBox
                error={new Error(job.data?.job.failureReason ?? "Analysis failed")}
                title="Story analysis failed"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn-primary"
                  onClick={async () => {
                    try {
                      const r = await post<{ job: { id: string } }>(`/generations/${jobId}/retry`);
                      setJobId(r.job.id);
                    } catch (e) {
                      setError(e);
                    }
                  }}
                >
                  Retry analysis
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => projectId && navigate({ to: "/projects/$projectId/story", params: { projectId } })}
                >
                  Edit story
                </button>
              </div>
            </>
          )}
          {status === "completed" && analysis.data && (
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm">Analysis complete. Review and edit the extracted data before it is applied.</div>
              <button type="button" className="btn-primary" onClick={() => setStep(3)}>
                Review <ArrowRight className="size-4" />
              </button>
            </div>
          )}
        </div>
      )}

      {step === 3 && analysis.data && projectId && (
        <AnalysisReview
          analysis={analysis.data.analysis}
          projectId={projectId}
          onApplied={() => navigate({ to: "/projects/$projectId", params: { projectId } })}
        />
      )}
    </div>
  );
}
