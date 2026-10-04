import type { NarrationFindingRow } from "@openmanga/db/types";
import { NARRATION_LANGUAGES } from "@openmanga/domain/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import clsx from "clsx";
import { AudioLines, ListChecks, Mic, Sparkles, Wand2 } from "lucide-react";
import { useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { EmptyState, ErrorBox, Modal, PageHeader, Spinner, Tabs, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";

type Finding = NarrationFindingRow & { fixable: boolean; check: "rule" | "ai" | "audio" };
type Loudness = {
  chapterId: string;
  lufs: number | null;
  lra: number | null;
  truePeakDb: number | null;
  measuredAt: string | null;
};
type Findings = {
  findings: Finding[];
  audio: Loudness[];
  lines: { id: string; chapterId: string; order: number; text: string }[];
  counts: { byStatus: Record<string, number>; openByKind: Record<string, number> };
};
type Density = {
  target: { wordsPerShot: number; wordsPerMinute: number };
  chapters: {
    id: string;
    order: number;
    title: string;
    words: number;
    shotCount: number;
    silentShots: number;
    wordsPerShot: number;
    wordsPerMinute: number | null;
    audioMs: number | null;
    /** Shot by shot, for the chapter asked about. */
    shots?: { id: string; words: number; silent: boolean }[];
  }[];
};
type Comparison = { found: number; introduced: number; remaining: number; resolved: number };
type JobView = { job: { id: string; kind: string; status: string; failureReason: string | null; result: unknown } };
type Proposal = { lineId: string; key: string; before: string; after: string };

const KIND_LABEL: Record<string, string> = {
  repeated_opening: "Repeated openings",
  flat_rhythm: "Flat rhythm",
  name_overuse: "Name used too often",
  near_duplicate: "Near-duplicate lines",
  restates_dialogue: "Restates the dialogue",
  chapter_opening: "Chapter opens alike",
  chapter_ending: "Chapter ends alike",
  dense_shot: "Crowded shot",
  silent_stretch: "Silent stretch",
  pace: "Pace",
  repeated_meaning: "Meaning repeated",
  cross_chapter_repeat: "Repeats an earlier chapter",
  fact_overexplained: "Fact explained again",
  describes_frame: "Only describes the frame",
  audio_silent: "Silent audio",
  audio_clipping: "Clipping",
  audio_gap: "Stall inside a line",
  audio_level: "Level out of step",
  audio_loudness: "Chapter loudness",
};
const SEVERITY_STYLE: Record<string, string> = {
  high: "bg-red-500/15 text-red-700 dark:text-red-300",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  low: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};
const summary = (c: Comparison) =>
  `${c.found} found · ${c.introduced} new · ${c.resolved} resolved since the last check`;
const sumComparisons = (rows: Comparison[]) =>
  rows.reduce(
    (a, r) => ({
      found: a.found + r.found,
      introduced: a.introduced + r.introduced,
      remaining: a.remaining + r.remaining,
      resolved: a.resolved + r.resolved,
    }),
    { found: 0, introduced: 0, remaining: 0, resolved: 0 },
  );

/**
 * Narration QA for a chapter or the whole project: the findings of the deterministic and AI checks, by type, to
 * review, ignore or fix; fixes rewrite only the flagged lines and are shown as a diff before they are applied.
 */
export function NarrationQaPage() {
  const projectId = useProjectId();
  const { data: overview } = useProject();
  const search = useSearch({ strict: false }) as { chapterId?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const chapterId = search.chapterId;
  const [language, setLanguage] = useState<string>();
  const lang = language ?? overview?.project.language ?? "en";
  const [tab, setTab] = useState<"findings" | "density" | "loudness">("findings");
  const [status, setStatus] = useState<"open" | "ignored" | "fixed">("open");
  const [kind, setKind] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** Jobs this page started and is waiting on: AI checks, and fixes whose proposal opens for review. */
  const [jobs, setJobs] = useState<{ id: string; kind: "lint" | "fix" | "audio"; chapterId: string }[]>([]);
  const [review, setReview] = useState<{ jobId: string; chapterId: string; proposals: Proposal[] } | null>(null);
  const aiText = useAiBody("text");
  const aiTts = useAiBody("tts");

  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const scope = `language=${encodeURIComponent(lang)}${chapterId ? `&chapterId=${chapterId}` : ""}`;
  const findingsKey = ["narration-qa", projectId, lang, chapterId ?? "all"] as const;
  const findings = useQuery({
    queryKey: findingsKey,
    queryFn: () => get<Findings>(`/projects/${projectId}/narration/findings?${scope}`),
  });
  const density = useQuery({
    queryKey: ["narration-density", projectId, lang, chapterId ?? "all"],
    queryFn: () => get<Density>(`/projects/${projectId}/narration/density?${scope}`),
    enabled: tab === "density",
  });
  // Polls the jobs this page started; a finished check refreshes the findings, a finished fix opens its review.
  useQuery({
    queryKey: ["narration-qa-jobs", jobs.map((j) => j.id).join(",")],
    enabled: jobs.length > 0,
    refetchInterval: 2500,
    queryFn: async () => {
      for (const j of jobs) {
        const { job } = await get<JobView>(`/generations/${j.id}`);
        if (job.status === "completed" && j.kind === "fix") {
          const proposals = (job.result as { proposals?: Proposal[] } | null)?.proposals ?? [];
          if (proposals.length) setReview({ jobId: j.id, chapterId: j.chapterId, proposals });
          else toast.success("The model found nothing to change in those lines");
        }
        if (job.status === "completed" && j.kind === "lint")
          toast.success(`AI check: ${summary(job.result as Comparison)}`);
        if (job.status === "completed" && j.kind === "audio")
          toast.success(`Audio check: ${summary(job.result as Comparison)}`);
        if (job.status === "failed") toast.error(new Error(job.failureReason ?? "The job failed"));
        if (["completed", "failed", "cancelled"].includes(job.status)) {
          setJobs((all) => all.filter((x) => x.id !== j.id));
          await qc.invalidateQueries({ queryKey: findingsKey });
        }
      }
      return jobs.length;
    },
  });

  const lintUrl = chapterId ? `/chapters/${chapterId}/narration/lint` : `/projects/${projectId}/narration/lint`;
  const runRules = useAction(() => post<{ rules: Comparison | Comparison[] }>(lintUrl, { language: lang }), {
    invalidate: [findingsKey],
    success: (r) => `Checks: ${summary(Array.isArray(r.rules) ? sumComparisons(r.rules) : r.rules)}`,
  });
  const runAi = useAction(
    () =>
      post<{ job?: { id: string; targetId: string } | null; jobs?: { id: string; targetId: string }[] }>(lintUrl, {
        language: lang,
        semantic: true,
        ...aiText(),
      }),
    {
      invalidate: [findingsKey],
      success: (r) => {
        const started = r.jobs ?? (r.job ? [r.job] : []);
        setJobs((all) => [...all, ...started.map((j) => ({ id: j.id, kind: "lint" as const, chapterId: j.targetId }))]);
        return `AI check queued for ${started.length} chapter(s); paste-mode jobs wait in Generation`;
      },
    },
  );
  const runAudio = useAction(
    () => post<{ audioJob: { id: string; targetId: string } }>(lintUrl, { language: lang, audio: true }),
    {
      invalidate: [findingsKey],
      success: (r) => {
        setJobs((all) => [...all, { id: r.audioJob.id, kind: "audio", chapterId: r.audioJob.targetId }]);
        return "Audio check queued";
      },
    },
  );
  // A new take of the lines an audio finding points at; the finding stays open until the audio is checked again.
  const revoice = useAction(
    (f: Finding) =>
      post<{ queued: number }>(`/chapters/${f.chapterId}/narration/synthesize`, {
        lineIds: f.lineIds,
        onlyMissing: false,
        newTake: true,
        language: lang,
        ...aiTts(),
      }),
    { success: (r) => `${r.queued} segment(s) queued for a new take — check the audio again once they are done` },
  );
  const setFindingStatus = useAction(
    (v: { id: string; status: "open" | "ignored" }) => patch(`/narration-findings/${v.id}`, { status: v.status }),
    { invalidate: [findingsKey] },
  );
  const fix = useAction(
    async () => {
      const chosen = (findings.data?.findings ?? []).filter((f) => selected.has(f.id));
      const byChapter = new Map<string, Finding[]>();
      for (const f of chosen) byChapter.set(f.chapterId, [...(byChapter.get(f.chapterId) ?? []), f]);
      const started: { id: string; chapterId: string }[] = [];
      for (const [ch, list] of byChapter) {
        const r = await post<{ job: { id: string } }>(`/chapters/${ch}/narration/fix`, {
          findingIds: list.map((f) => f.id),
          language: lang,
          ...aiText(),
        });
        started.push({ id: r.job.id, chapterId: ch });
      }
      return started;
    },
    {
      success: (started) => {
        setJobs((all) => [...all, ...started.map((s) => ({ ...s, kind: "fix" as const }))]);
        setSelected(new Set());
        return `Fix queued for ${started.length} chapter(s): the proposal opens here for review`;
      },
    },
  );

  const all = findings.data?.findings ?? [];
  const shown = all.filter((f) => f.status === status && (!kind || f.kind === kind));
  const lineText = new Map((findings.data?.lines ?? []).map((l) => [l.id, l]));
  const chapterName = new Map((chapters.data?.chapters ?? []).map((c) => [c.id, `Ch. ${c.order} — ${c.title}`]));
  const busy = jobs.length > 0;

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Narration QA"
        subtitle="Repetition, restated dialogue, crowded or silent shots and pace — reviewed, ignored or fixed line by line."
        actions={
          <>
            <select
              className="input w-auto max-w-full"
              aria-label="Chapter"
              value={chapterId ?? ""}
              onChange={(e) =>
                navigate({
                  to: "/projects/$projectId/narration/qa",
                  params: { projectId },
                  search: e.target.value ? { chapterId: e.target.value } : {},
                })
              }
            >
              <option value="">All chapters</option>
              {chapters.data?.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  Ch. {c.order} — {c.title}
                </option>
              ))}
            </select>
            <select
              className="input w-auto"
              aria-label="Narration language"
              value={lang}
              onChange={(e) => setLanguage(e.target.value)}
            >
              {NARRATION_LANGUAGES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name}
                </option>
              ))}
            </select>
            <Link
              to="/projects/$projectId/narration"
              params={{ projectId }}
              search={chapterId ? { chapterId } : {}}
              className="btn-ghost"
            >
              Narration →
            </Link>
          </>
        }
      />

      <div className="card mb-4 flex flex-wrap items-center gap-2 p-4">
        <button
          type="button"
          className="btn-primary"
          onClick={() => runRules.mutate()}
          disabled={runRules.isPending}
          title="Counting and comparing checks: no model, nothing spent"
        >
          {runRules.isPending ? <Spinner /> : <ListChecks className="size-4" />} Run checks
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => runAi.mutate()}
          disabled={runAi.isPending}
          title="Meaning repeated in other words, facts explained again and lines that only describe the frame: a text job per chapter"
        >
          <Sparkles className="size-4" /> Check with AI
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => runAudio.mutate()}
          disabled={runAudio.isPending}
          title="Silent, clipped or stalled takes, uneven levels and each chapter's loudness, measured in the voiced audio: no model, nothing spent"
        >
          <AudioLines className="size-4" /> Check audio
        </button>
        <AiChip cap="text" />
        {busy && (
          <Link
            to="/projects/$projectId/generation"
            params={{ projectId }}
            className="muted flex items-center gap-1 text-xs underline"
            title="Paste-mode jobs wait for your answer there"
          >
            <Spinner className="size-3" /> {jobs.length} job(s) running · Generation
          </Link>
        )}
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "findings", label: `Findings (${findings.data?.counts.byStatus.open ?? 0} open)` },
          { value: "density", label: "Density" },
          { value: "loudness", label: "Loudness" },
        ]}
      />

      {tab === "density" ? (
        <DensityView data={density.data} loading={density.isLoading} chapterId={chapterId} />
      ) : tab === "loudness" ? (
        <LoudnessView
          rows={findings.data?.audio ?? []}
          chapters={chapters.data?.chapters ?? []}
          chapterId={chapterId}
        />
      ) : (
        <>
          {findings.error && <ErrorBox error={findings.error} onRetry={() => findings.refetch()} />}
          <div className="mb-3 flex flex-wrap gap-1.5">
            <button
              type="button"
              className={clsx("chip", !kind && "ring-2 ring-accent-500")}
              onClick={() => setKind(null)}
            >
              All open · {findings.data?.counts.byStatus.open ?? 0}
            </button>
            {Object.entries(findings.data?.counts.openByKind ?? {}).map(([k, n]) => (
              <button
                key={k}
                type="button"
                className={clsx("chip", kind === k && "ring-2 ring-accent-500")}
                onClick={() => setKind(kind === k ? null : k)}
              >
                {KIND_LABEL[k] ?? k} · {n}
              </button>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <select
              className="input w-auto"
              aria-label="Status"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value as typeof status);
                setSelected(new Set());
              }}
            >
              <option value="open">Open ({findings.data?.counts.byStatus.open ?? 0})</option>
              <option value="ignored">Ignored ({findings.data?.counts.byStatus.ignored ?? 0})</option>
              <option value="fixed">Fixed ({findings.data?.counts.byStatus.fixed ?? 0})</option>
            </select>
            {status === "open" && (
              <button
                type="button"
                className="btn-secondary ml-auto"
                disabled={!selected.size || fix.isPending}
                onClick={() => fix.mutate()}
                title="Rewrite only the selected findings' lines; you review the changes before anything is saved"
              >
                <Wand2 className="size-4" /> Fix selected ({selected.size})
              </button>
            )}
          </div>
          {findings.isLoading ? (
            <Spinner />
          ) : !shown.length ? (
            <EmptyState icon={<ListChecks className="size-8" />} title={`No ${status} findings`}>
              {all.length ? "Nothing here with this filter." : "Run the checks to review this narration."}
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {shown.map((f) => (
                <li key={f.id} className="card flex gap-3 p-3">
                  {status === "open" && (
                    <input
                      type="checkbox"
                      className="mt-1 shrink-0"
                      aria-label="Select to fix"
                      disabled={!f.fixable}
                      title={
                        f.fixable
                          ? "Select to fix"
                          : f.check === "audio"
                            ? "Needs a new take of the audio, not a rewrite"
                            : "Needs lines added or the voice changed, not a rewrite"
                      }
                      checked={selected.has(f.id)}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(f.id);
                        else next.delete(f.id);
                        setSelected(next);
                      }}
                    />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-1.5 text-sm">
                      <span className="font-medium">{KIND_LABEL[f.kind] ?? f.kind}</span>
                      <span className={clsx("chip", SEVERITY_STYLE[f.severity])}>{f.severity}</span>
                      <span className="chip">{f.check === "ai" ? "AI" : f.check}</span>
                      {!chapterId && (
                        <Link
                          to="/projects/$projectId/narration/qa"
                          params={{ projectId }}
                          search={{ chapterId: f.chapterId }}
                          className="muted text-xs underline"
                        >
                          {chapterName.get(f.chapterId) ?? "Chapter"}
                        </Link>
                      )}
                    </div>
                    <p className="text-sm">{f.message}</p>
                    {f.lineIds.map((id) => (
                      <blockquote key={id} className="muted border-l-2 border-[var(--border)] pl-2 text-xs">
                        {lineText.get(id)?.text ?? "(line deleted)"}
                      </blockquote>
                    ))}
                    {f.relatedChapterIds.length > 0 && (
                      <p className="muted text-xs">
                        Also: {f.relatedChapterIds.map((id) => chapterName.get(id) ?? "a chapter").join(", ")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    {f.check === "audio" && f.status === "open" && f.lineIds.length > 0 && (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        disabled={revoice.isPending}
                        title="Synthesize these lines again, even where the same take is cached"
                        onClick={() => revoice.mutate(f)}
                      >
                        <Mic className="size-3.5" /> New take
                      </button>
                    )}
                    {f.status === "ignored" || f.status === "fixed" ? (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setFindingStatus.mutate({ id: f.id, status: "open" })}
                      >
                        Reopen
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost text-xs"
                        onClick={() => setFindingStatus.mutate({ id: f.id, status: "ignored" })}
                      >
                        Ignore
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {review && (
        <FixReview
          review={review}
          chapter={chapterName.get(review.chapterId) ?? "Chapter"}
          ttsBody={aiTts}
          onClose={() => setReview(null)}
          onApplied={(r) => {
            setReview(null);
            if (r.recheckJob)
              setJobs((all) => [...all, { id: r.recheckJob!.id, kind: "lint", chapterId: review.chapterId }]);
            void qc.invalidateQueries({ queryKey: findingsKey });
            void qc.invalidateQueries({ queryKey: qk.narration(review.chapterId) });
          }}
        />
      )}
    </div>
  );
}

type Applied = {
  applied: string[];
  skipped: string[];
  revoiced: number;
  rules: Comparison;
  recheckJob: { id: string } | null;
};

/** The proposal as a diff, line by line, each line accepted or not; nothing is saved until Apply. */
function FixReview({
  review,
  chapter,
  ttsBody,
  onClose,
  onApplied,
}: {
  review: { jobId: string; chapterId: string; proposals: Proposal[] };
  chapter: string;
  ttsBody: () => Record<string, unknown>;
  onClose: () => void;
  onApplied: (r: Applied) => void;
}) {
  const [accepted, setAccepted] = useState(new Set(review.proposals.map((p) => p.lineId)));
  const [revoice, setRevoice] = useState(true);
  const [recheck, setRecheck] = useState(false);
  const apply = useAction(
    () =>
      post<Applied>(`/chapters/${review.chapterId}/narration/fix/apply`, {
        jobId: review.jobId,
        lineIds: [...accepted],
        revoice,
        recheck,
        ...(revoice ? ttsBody() : {}),
      }),
    {
      success: (r) =>
        `Applied ${r.applied.length} line(s)${r.skipped.length ? `, skipped ${r.skipped.length} edited since` : ""}` +
        `${r.revoiced ? ` · re-voicing ${r.revoiced} segment(s)` : ""} · checks: ${summary(r.rules)}`,
      onSuccess: onApplied,
    },
  );
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Proposed fixes · ${chapter}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Discard
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!accepted.size || apply.isPending}
            onClick={() => apply.mutate()}
          >
            {apply.isPending && <Spinner />} Apply {accepted.size} line(s)
          </button>
        </>
      }
    >
      <p className="muted mb-3 text-sm">
        Only the flagged lines are rewritten. After applying, the checks run again on the chapter so you can see whether
        the fix brought new findings.
      </p>
      <ul className="space-y-3">
        {review.proposals.map((p) => (
          <li key={p.lineId} className="rounded-lg border border-[var(--border)] p-3">
            <label className="mb-2 flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={accepted.has(p.lineId)}
                onChange={(e) => {
                  const next = new Set(accepted);
                  if (e.target.checked) next.add(p.lineId);
                  else next.delete(p.lineId);
                  setAccepted(next);
                }}
              />
              Line {p.key.slice(1)}
            </label>
            <p className="rounded bg-red-500/10 p-2 text-sm text-red-800 line-through decoration-red-500/60 dark:text-red-200">
              {p.before}
            </p>
            <p className="mt-1 rounded bg-emerald-500/10 p-2 text-sm text-emerald-800 dark:text-emerald-200">
              {p.after}
            </p>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={revoice} onChange={(e) => setRevoice(e.target.checked)} />
          Re-voice the changed sentences
        </label>
        {revoice && <AiChip cap="tts" />}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={recheck} onChange={(e) => setRecheck(e.target.checked)} />
          Check again with AI (same model as the fix)
        </label>
      </div>
    </Modal>
  );
}

function DensityView({
  data,
  loading,
  chapterId,
}: {
  data: Density | undefined;
  loading: boolean;
  chapterId?: string;
}) {
  if (loading || !data) return <Spinner />;
  const one = chapterId ? data.chapters.find((c) => c.id === chapterId) : undefined;
  const max = Math.max(data.target.wordsPerShot * 2, ...(one?.shots ?? []).map((s) => s.words));
  return (
    <div className="space-y-4">
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[34rem] text-sm">
          <thead className="muted text-left text-xs">
            <tr>
              <th className="p-2">Chapter</th>
              <th className="p-2 text-right">Words</th>
              <th className="p-2 text-right">Shots</th>
              <th className="p-2 text-right">Words / shot</th>
              <th className="p-2 text-right">Silent shots</th>
              <th className="p-2 text-right">Words / min</th>
            </tr>
          </thead>
          <tbody>
            {(one ? [one] : data.chapters).map((c) => {
              const off =
                c.wordsPerMinute &&
                Math.abs(c.wordsPerMinute - data.target.wordsPerMinute) > data.target.wordsPerMinute * 0.25;
              return (
                <tr key={c.id} className="border-t border-[var(--border)]">
                  <td className="p-2">
                    Ch. {c.order} — {c.title}
                  </td>
                  <td className="p-2 text-right tabular-nums">{c.words}</td>
                  <td className="p-2 text-right tabular-nums">{c.shotCount}</td>
                  <td className="p-2 text-right tabular-nums">{c.wordsPerShot.toFixed(1)}</td>
                  <td className={clsx("p-2 text-right tabular-nums", c.silentShots && "text-amber-600")}>
                    {c.silentShots}
                  </td>
                  <td className={clsx("p-2 text-right tabular-nums", off && "text-amber-600")}>
                    {c.wordsPerMinute ?? "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Target: about {data.target.wordsPerShot} words a shot and {data.target.wordsPerMinute} words a minute. Words a
        minute come from current audio only; "—" until the chapter is voiced.
      </p>
      {one?.shots && (
        <div className="card p-3">
          <h2 className="mb-2 text-sm font-medium">Shot by shot</h2>
          <div className="overflow-x-auto">
            <div className="flex h-28 items-end gap-px" style={{ minWidth: `${one.shots.length * 6}px` }}>
              {one.shots.map((s, i) => (
                <div
                  key={s.id}
                  title={`Shot ${i + 1}: ${s.words} words${s.silent ? " (silent)" : ""}`}
                  className={clsx(
                    "min-w-[4px] flex-1 rounded-t-sm",
                    s.silent
                      ? "bg-amber-500/60"
                      : s.words > data.target.wordsPerShot * 2
                        ? "bg-red-500/70"
                        : "bg-accent-500/70",
                  )}
                  style={{ height: `${Math.max(4, (Math.min(s.words, max) / max) * 100)}%` }}
                />
              ))}
            </div>
          </div>
          <p className="muted mt-2 text-xs">
            Bars are words per shot; amber shots have no narration, red ones carry more than twice the target.
          </p>
        </div>
      )}
      {chapterId && !one?.shots?.length && <p className="muted text-sm">This chapter has no planned shots yet.</p>}
    </div>
  );
}

/** Each chapter's loudness from the newest audio check: what the film's normalisation to -14 LUFS starts from. */
function LoudnessView({
  rows,
  chapters,
  chapterId,
}: {
  rows: Loudness[];
  chapters: ChapterListItem[];
  chapterId?: string;
}) {
  const by = new Map(rows.map((r) => [r.chapterId, r]));
  const list = chapters.filter((c) => (chapterId ? c.id === chapterId : by.has(c.id)));
  if (!rows.length)
    return (
      <EmptyState icon={<AudioLines className="size-8" />} title="Not measured yet">
        Run <b>Check audio</b> to measure each voiced chapter's loudness and true peak.
      </EmptyState>
    );
  const num = (n: number | null, unit: string) => (n === null ? "—" : `${n.toFixed(1)} ${unit}`);
  return (
    <div className="space-y-3">
      <div className="card overflow-x-auto p-0">
        <table className="w-full min-w-[30rem] text-sm">
          <thead className="muted text-left text-xs">
            <tr>
              <th className="p-2">Chapter</th>
              <th className="p-2 text-right">Loudness</th>
              <th className="p-2 text-right">Range</th>
              <th className="p-2 text-right">True peak</th>
              <th className="p-2 text-right">Measured</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => {
              const r = by.get(c.id);
              return (
                <tr key={c.id} className="border-t border-[var(--border)]">
                  <td className="p-2">
                    Ch. {c.order} — {c.title}
                  </td>
                  <td className="p-2 text-right tabular-nums">{num(r?.lufs ?? null, "LUFS")}</td>
                  <td className="p-2 text-right tabular-nums">{num(r?.lra ?? null, "LU")}</td>
                  <td
                    className={clsx(
                      "p-2 text-right tabular-nums",
                      (r?.truePeakDb ?? -99) > -1 && "text-amber-600 dark:text-amber-400",
                    )}
                  >
                    {num(r?.truePeakDb ?? null, "dBTP")}
                  </td>
                  <td className="muted p-2 text-right text-xs">
                    {r?.measuredAt ? new Date(r.measuredAt).toLocaleDateString() : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted text-xs">
        Measured on the voiced narration with its pauses (EBU R128). A video export normalises the whole film to -14
        LUFS with peaks under -1.5 dBTP, so what matters here is that chapters sit close together; a true peak above -1
        dBTP (amber) is close to clipping before normalisation.
      </p>
    </div>
  );
}
