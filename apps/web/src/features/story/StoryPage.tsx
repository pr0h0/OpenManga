import { useQuery, useQueryClient } from "@tanstack/react-query";
import { History, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { onProjectEvent, qk } from "../../api/hooks.ts";
import type { StoryAnalysisRow, StoryRevisionRow, StoryState } from "../../api/types.ts";
import {
  clsx,
  EmptyState,
  ErrorBox,
  fmt,
  Modal,
  PageHeader,
  SaveIndicator,
  Spinner,
  StatusChip,
  toast,
  useAutosave,
} from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { AnalysisReview } from "./AnalysisReview.tsx";
import { StoryCoverage } from "./StoryCoverage.tsx";

export function StoryPage() {
  const aiText = useAiBody("text");
  const projectId = useProjectId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: qk.story(projectId), queryFn: () => get<StoryState>(`/projects/${projectId}/story`) });
  const [viewRevisionId, setViewRevisionId] = useState<string | null>(null);
  const [analysisId, setAnalysisId] = useState<string | null>(null);
  const [rewriteOpen, setRewriteOpen] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(
    () =>
      onProjectEvent((e) => {
        if (e.type === "job.updated" && e.kind === "story_rewrite" && e.status === "completed")
          toast.success("AI rewrite saved as a new revision");
        if (e.type === "analysis.updated" && e.status === "completed") setAnalysisId(String(e.analysisId));
      }),
    [],
  );

  if (q.isLoading)
    return (
      <div className="p-6">
        <Spinner className="size-6" />
      </div>
    );
  if (q.error)
    return (
      <div className="p-6">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const data = q.data!;
  const latest = data.latest;
  const viewing = viewRevisionId && viewRevisionId !== latest?.id ? viewRevisionId : null;
  const selectedAnalysis =
    data.analyses.find((a) => a.id === analysisId) ??
    data.analyses.find((a) => a.status === "completed" || a.status === "applied") ??
    null;

  const analyze = async () => {
    if (!latest) return;
    setAnalyzing(true);
    try {
      const r = await post<{ analysis: StoryAnalysisRow }>(`/story-revisions/${latest.id}/analyze`, aiText());
      setAnalysisId(r.analysis.id);
      await qc.invalidateQueries({ queryKey: qk.story(projectId) });
      toast.info("Analysis queued");
    } catch (e) {
      toast.error(e);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        title="Story"
        subtitle="Every analysis references a specific revision. Analyzed revisions are locked; editing forks a new revision."
        actions={
          latest && (
            <>
              <button type="button" className="btn-secondary" onClick={() => setRewriteOpen(true)}>
                <Wand2 className="size-4" /> AI rewrite
              </button>
              <AiChip cap="text" />
              <button type="button" className="btn-primary" onClick={analyze} disabled={analyzing}>
                {analyzing ? <Spinner /> : <Sparkles className="size-4" />} Analyze revision {latest.revisionNumber}
              </button>
            </>
          )
        }
      />
      {!latest ? (
        <NewStory projectId={projectId} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
          <div className="min-w-0">
            {viewing ? (
              <RevisionViewer id={viewing} projectId={projectId} onClose={() => setViewRevisionId(null)} />
            ) : (
              <StoryEditor key={projectId} revision={latest} projectId={projectId} />
            )}
          </div>
          <aside className="space-y-4">
            <div className="card p-3">
              <h3 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <History className="size-4" /> Revisions
              </h3>
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {data.revisions.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setViewRevisionId(r.id === latest.id ? null : r.id)}
                      className={clsx(
                        "w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-[var(--panel-2)]",
                        (viewing ? viewing === r.id : r.id === latest.id) && "bg-[var(--panel-2)]",
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className="font-medium">Rev {r.revisionNumber}</span>
                        <span className="muted text-[11px]">{r.source.replace("_", " ")}</span>
                      </div>
                      <div className="muted text-[11px]">
                        {fmt.num(r.length)} chars · {fmt.ago(r.updatedAt)} {r.lockedAt ? "· 🔒 analyzed" : ""}
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
            <div className="card p-3">
              <h3 className="mb-2 text-sm font-medium">Analyses</h3>
              {!data.analyses.length && (
                <p className="muted text-xs">Run an analysis to extract cast, world and chapters.</p>
              )}
              <ul className="space-y-1">
                {data.analyses.map((a) => {
                  const rev = data.revisions.find((r) => r.id === a.storyRevisionId);
                  return (
                    <li key={a.id}>
                      <button
                        type="button"
                        onClick={() => setAnalysisId(a.id)}
                        className={clsx(
                          "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-[var(--panel-2)]",
                          selectedAnalysis?.id === a.id && "bg-[var(--panel-2)]",
                        )}
                      >
                        <span>
                          Rev {rev?.revisionNumber ?? "?"} · {fmt.ago(a.createdAt)}
                        </span>
                        <StatusChip status={a.status} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          </aside>
        </div>
      )}
      {selectedAnalysis && (selectedAnalysis.status === "completed" || selectedAnalysis.status === "applied") && (
        <section className="mt-8">
          <h2 className="mb-3 text-lg font-semibold">Analysis review</h2>
          <AnalysisReview analysis={selectedAnalysis} projectId={projectId} />
        </section>
      )}
      {data.analyses.some((a) => a.status === "applied") && (
        <StoryCoverage
          projectId={projectId}
          onShowSpan={(revisionId, start, end) => {
            if (revisionId !== latest?.id) {
              setViewRevisionId(revisionId);
              toast.info(`The report is for an earlier revision: characters ${start}–${end} of it`);
              return;
            }
            setViewRevisionId(null);
            // The editor holds the latest revision; select the span in it and bring it into view.
            requestAnimationFrame(() => {
              const t = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Story content"]');
              if (!t) return;
              t.focus();
              t.setSelectionRange(start, end);
              const line = Number.parseFloat(getComputedStyle(t).lineHeight) || 20;
              t.scrollTop = Math.max(0, (t.value.slice(0, start).split("\n").length - 3) * line);
              t.scrollIntoView({ block: "center", behavior: "smooth" });
            });
          }}
        />
      )}
      {data.analyses.some((a) => a.status === "pending") && (
        <div className="card mt-6 flex items-center gap-2 p-3 text-sm">
          <Spinner /> An analysis is running. Results appear here automatically.
        </div>
      )}
      {latest && <RewriteModal open={rewriteOpen} onClose={() => setRewriteOpen(false)} revisionId={latest.id} />}
    </div>
  );
}

function StoryEditor({ revision, projectId }: { revision: StoryRevisionRow; projectId: string }) {
  const qc = useQueryClient();
  const [content, setContent] = useState(revision.content);
  const [title, setTitle] = useState(revision.title);
  const [base, setBase] = useState({
    id: revision.id,
    sha: revision.contentSha256,
    locked: Boolean(revision.lockedAt),
  });
  const newer = revision.id !== base.id && revision.contentSha256 !== base.sha;
  const { state, markSaved } = useAutosave({ content, title }, async (v) => {
    const r = await patch<{ revision: StoryRevisionRow; forked: boolean }>(`/story-revisions/${base.id}`, {
      content: v.content,
      title: v.title,
      baseSha256: base.locked ? undefined : base.sha,
    });
    setBase({ id: r.revision.id, sha: r.revision.contentSha256, locked: Boolean(r.revision.lockedAt) });
    if (r.forked) {
      toast.info(`Saved as new revision ${r.revision.revisionNumber} (previous revision is locked by an analysis)`);
    }
    await qc.invalidateQueries({ queryKey: qk.story(projectId) });
  });
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <input
          className="input max-w-sm font-medium"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled"
          aria-label="Story title"
        />
        <span className="muted text-xs">
          Rev {revision.revisionNumber} · {revision.inputKind}
          {base.locked ? " · locked (edits fork a new revision)" : ""}
        </span>
        <span className="ml-auto">
          <SaveIndicator state={state} />
        </span>
      </div>
      {newer && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-accent-500/40 bg-accent-600/10 p-2 text-sm">
          <span>
            Revision {revision.revisionNumber} ({revision.source.replace("_", " ")}) is newer than the text you are
            editing.
          </span>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => {
              markSaved({ content: revision.content, title: revision.title });
              setContent(revision.content);
              setTitle(revision.title);
              setBase({ id: revision.id, sha: revision.contentSha256, locked: Boolean(revision.lockedAt) });
            }}
          >
            Load revision {revision.revisionNumber}
          </button>
        </div>
      )}
      <textarea
        className="input min-h-[60vh] font-mono text-sm leading-relaxed"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        aria-label="Story content"
        spellCheck
      />
      <div className="muted mt-1 text-right text-xs">{content.length.toLocaleString()} characters</div>
    </div>
  );
}

function RevisionViewer({ id, projectId, onClose }: { id: string; projectId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["story-revision", id],
    queryFn: () => get<{ revision: StoryRevisionRow }>(`/story-revisions/${id}`),
  });
  const [busy, setBusy] = useState(false);
  if (!q.data) return <div className="card p-6">{q.error ? <ErrorBox error={q.error} /> : <Spinner />}</div>;
  const r = q.data.revision;
  return (
    <div className="card p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="font-medium">
          Revision {r.revisionNumber}{" "}
          <span className="muted text-xs">
            ({r.source.replace("_", " ")}, {fmt.date(r.createdAt)}) · read-only
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn-secondary" onClick={onClose}>
            Back to latest
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/projects/${projectId}/story/revisions`, {
                  content: r.content,
                  title: r.title,
                  inputKind: r.inputKind,
                });
                await qc.invalidateQueries({ queryKey: qk.story(projectId) });
                toast.success("Restored as a new revision");
                onClose();
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore as new revision
          </button>
        </div>
      </div>
      <pre className="max-h-[60vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-[var(--panel-2)] p-3 font-mono text-sm">
        {r.content}
      </pre>
    </div>
  );
}

function NewStory({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <EmptyState title="No story yet" action={null}>
      <div className="mt-2 w-full max-w-2xl text-left">
        <textarea
          className="input min-h-60 font-mono text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Paste a story, chapter, outline, screenplay or idea…"
          aria-label="Story content"
        />
        <button
          type="button"
          className="btn-primary mt-2"
          disabled={!content.trim() || busy}
          onClick={async () => {
            setBusy(true);
            try {
              await post(`/projects/${projectId}/story/revisions`, { content });
              await qc.invalidateQueries({ queryKey: qk.story(projectId) });
            } catch (e) {
              toast.error(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy && <Spinner />} Save story
        </button>
      </div>
    </EmptyState>
  );
}

function RewriteModal({ open, onClose, revisionId }: { open: boolean; onClose: () => void; revisionId: string }) {
  const aiRewrite = useAiBody("text");
  const [instruction, setInstruction] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="AI rewrite"
      footer={
        <>
          <AiChip cap="text" className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy || instruction.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await post(`/story-revisions/${revisionId}/rewrite`, { ...aiRewrite(), instruction });
                toast.info("Rewrite queued. It will appear as a new revision.");
                setInstruction("");
                onClose();
              } catch (e) {
                toast.error(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />} Queue rewrite
          </button>
        </>
      }
    >
      <p className="muted mb-2 text-sm">
        The text model rewrites the current revision into a new revision. The original is never overwritten.
      </p>
      <textarea
        className="input min-h-28"
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="e.g. Tighten pacing, add more dialogue between Woo Jin and Do-yun, end on a cliffhanger."
        aria-label="Rewrite instruction"
      />
    </Modal>
  );
}
