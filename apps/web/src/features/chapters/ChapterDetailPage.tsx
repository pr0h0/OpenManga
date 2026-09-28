import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useCallback, useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { CastCard, ChapterDetail, ChapterListItem, ChapterRow, LocationCard } from "../../api/types.ts";
import {
  ErrorBox,
  PageHeader,
  SaveIndicator,
  Spinner,
  StatusChip,
  TagInput,
  useAutosave,
} from "../../components/ui.tsx";
import { VERSION_ACTIONS } from "../cast/fields.tsx";
import { ActiveBatches } from "../generation/BatchStatus.tsx";
import { BulkGenerateButton } from "../pages/BulkGenerate.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { PreviewVideoButton } from "../video/VideoPreview.tsx";
import { DeleteChapterButton } from "./DeleteChapterButton.tsx";
import { PlanButton } from "./PlanButton.tsx";
import { SceneEditor } from "./SceneEditor.tsx";

export function ChapterDetailPage() {
  const projectId = useProjectId();
  const { chapterId } = useParams({ strict: false }) as { chapterId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: qk.chapter(chapterId),
    queryFn: () => get<ChapterDetail>(`/chapters/${chapterId}`),
  });
  // For the previous / next chapter links: the same list the chapters page shows, usually already cached.
  const siblings = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const locations = useQuery({
    queryKey: qk.locations(projectId),
    queryFn: () => get<{ locations: LocationCard[] }>(`/projects/${projectId}/locations`),
  });
  const cast = useQuery({
    queryKey: qk.cast(projectId),
    queryFn: () => get<{ characters: CastCard[] }>(`/projects/${projectId}/characters`),
  });
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.chapter(chapterId) });
    qc.invalidateQueries({ queryKey: qk.chapters(projectId) });
  }, [qc, chapterId, projectId]);
  const addScene = useAction(() => post(`/chapters/${chapterId}/scenes`, { title: "New scene" }), {
    onSuccess: refresh,
  });
  const setPlanStatus = useAction((planStatus: string) => patch(`/chapters/${chapterId}`, { planStatus }), {
    onSuccess: refresh,
  });

  if (isLoading)
    return (
      <div className="p-6">
        <Spinner className="size-6" />
      </div>
    );
  if (error || !data)
    return (
      <div className="p-6">
        <ErrorBox error={error} onRetry={() => refetch()} />
      </div>
    );
  const ch = data.chapter;
  const ordered = [...(siblings.data?.chapters ?? [])].sort((a, b) => a.order - b.order);
  const at = ordered.findIndex((c) => c.id === ch.id);
  const [prev, next] = at < 0 ? [undefined, undefined] : [ordered[at - 1], ordered[at + 1]];

  return (
    <div className="space-y-5 p-6">
      <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Chapters">
        <Link to="/projects/$projectId/chapters" params={{ projectId }} className="muted mr-auto hover:underline">
          ← Chapters
        </Link>
        {prev && (
          <Link
            to="/projects/$projectId/chapters/$chapterId"
            params={{ projectId, chapterId: prev.id }}
            className="btn-secondary max-w-full px-2 py-1 text-xs"
            title={`Chapter ${prev.order}: ${prev.title}`}
          >
            <ChevronLeft className="size-3.5 shrink-0" />
            <span className="max-w-48 truncate">
              Ch. {prev.order}: {prev.title}
            </span>
          </Link>
        )}
        {next && (
          <Link
            to="/projects/$projectId/chapters/$chapterId"
            params={{ projectId, chapterId: next.id }}
            className="btn-secondary max-w-full px-2 py-1 text-xs"
            title={`Chapter ${next.order}: ${next.title}`}
          >
            <span className="max-w-48 truncate">
              Ch. {next.order}: {next.title}
            </span>
            <ChevronRight className="size-3.5 shrink-0" />
          </Link>
        )}
      </nav>
      <PageHeader
        title={`Chapter ${ch.order}: ${ch.title}`}
        subtitle={
          <span className="inline-flex items-center gap-2">
            plan <StatusChip status={ch.planStatus} />
          </span>
        }
        actions={
          <>
            {VERSION_ACTIONS[ch.planStatus]
              ?.filter((a) => a.status !== "superseded")
              .map((a) => (
                <button
                  key={a.status}
                  type="button"
                  className="btn-secondary"
                  onClick={() => setPlanStatus.mutate(a.status)}
                >
                  {a.label} plan
                </button>
              ))}
            {data.pages.length > 0 && (
              <PreviewVideoButton
                projectId={projectId}
                scope={{ chapterId }}
                title={`Preview — Chapter ${ch.order}: ${ch.title}`}
              />
            )}
            <Link
              to="/projects/$projectId/narration"
              params={{ projectId }}
              search={{ chapterId }}
              className="btn-secondary"
            >
              Narration
            </Link>
            {/* Each model chip sits in one group with the AI action it chooses the model for. */}
            <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-[var(--panel-2)] p-0.5">
              <PlanButton
                projectId={projectId}
                chapterId={chapterId}
                hasPages={data.pages.length > 0}
                label={data.pages.length ? "Replan" : "Plan chapter"}
              />
            </span>
            {data.pages.length > 0 && (
              <span className="inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-[var(--panel-2)] p-0.5">
                <BulkGenerateButton
                  projectId={projectId}
                  scope={{ chapterId }}
                  label="Generate all missing panels"
                  className="btn-secondary"
                />
              </span>
            )}
            <DeleteChapterButton
              projectId={projectId}
              chapter={ch}
              stats={{
                pages: data.pages.length,
                panels: data.pages.reduce((n, p) => n + p.panelCount, 0),
              }}
              onDeleted={() => navigate({ to: "/projects/$projectId/chapters", params: { projectId } })}
            />
          </>
        }
      />
      <ActiveBatches projectId={projectId} chapterId={chapterId} />

      <ChapterEditor key={ch.id} chapter={ch} onSaved={refresh} />

      <section className="card p-4">
        <div className="mb-3 flex items-center">
          <h2 className="mr-auto font-semibold">Scenes</h2>
          <button type="button" className="btn-secondary" onClick={() => addScene.mutate()}>
            <Plus className="size-4" /> Add scene
          </button>
        </div>
        <div className="space-y-2">
          {data.scenes.map((s) => (
            <SceneEditor
              projectId={projectId}
              key={`${s.id}-${s.updatedAt}`}
              scene={s}
              locations={(locations.data?.locations ?? []).map((l) => ({ id: l.id, name: l.name }))}
              cast={(cast.data?.characters ?? []).map((c) => ({ id: c.id, name: c.name }))}
              onChanged={refresh}
            />
          ))}
          {!data.scenes.length && <p className="muted text-sm">No scenes. Plan the chapter or add scenes manually.</p>}
        </div>
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-semibold">Pages</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {data.pages.map((pg) => (
            <Link
              key={pg.id}
              to="/projects/$projectId/pages/$pageId"
              params={{ projectId, pageId: pg.id }}
              search={{}}
              className="rounded-lg border border-[var(--border)] p-3 text-sm hover:bg-[var(--panel-2)]"
            >
              <div className="font-medium">Page {pg.order}</div>
              <div className="muted text-xs">
                {pg.readyCount}/{pg.panelCount} panels ready
              </div>
              <div className="muted truncate text-xs">{pg.layoutTemplate ?? "custom layout"}</div>
              <div className="mt-1">
                <StatusChip status={pg.status} />
              </div>
            </Link>
          ))}
        </div>
        {!data.pages.length && <p className="muted text-sm">No pages yet.</p>}
      </section>
    </div>
  );
}

type MemoryFields = Pick<
  ChapterRow,
  | "title"
  | "summary"
  | "sourceExcerpt"
  | "openingState"
  | "closingState"
  | "characterStateChanges"
  | "locationStateChanges"
  | "revealedFacts"
>;

function ChapterEditor({ chapter, onSaved }: { chapter: ChapterRow; onSaved: () => void }) {
  const [f, setF] = useState<MemoryFields>({
    title: chapter.title,
    summary: chapter.summary,
    sourceExcerpt: chapter.sourceExcerpt,
    openingState: chapter.openingState,
    closingState: chapter.closingState,
    characterStateChanges: chapter.characterStateChanges,
    locationStateChanges: chapter.locationStateChanges,
    revealedFacts: chapter.revealedFacts,
  });
  const { state } = useAutosave(f, async (v) => {
    await patch(`/chapters/${chapter.id}`, { ...v, title: v.title.trim() || chapter.title });
    onSaved();
  });
  const list = (k: "characterStateChanges" | "locationStateChanges" | "revealedFacts", label: string) => (
    <div>
      <span className="label">{label}</span>
      <TagInput value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} />
    </div>
  );
  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center">
        <h2 className="mr-auto font-semibold">Chapter & memory</h2>
        <SaveIndicator state={state} />
      </div>
      <label className="block">
        <span className="label">Title</span>
        <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </label>
      <label className="block">
        <span className="label">Summary</span>
        <textarea
          className="input min-h-16"
          value={f.summary}
          onChange={(e) => setF({ ...f, summary: e.target.value })}
        />
      </label>
      <label className="block">
        <span className="label">Source excerpt (planning input)</span>
        <textarea
          className="input min-h-40 font-mono text-xs"
          value={f.sourceExcerpt}
          onChange={(e) => setF({ ...f, sourceExcerpt: e.target.value })}
        />
      </label>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="label">Opening state</span>
          <textarea
            className="input min-h-16"
            value={f.openingState}
            onChange={(e) => setF({ ...f, openingState: e.target.value })}
          />
        </label>
        <label className="block">
          <span className="label">Closing state</span>
          <textarea
            className="input min-h-16"
            value={f.closingState}
            onChange={(e) => setF({ ...f, closingState: e.target.value })}
          />
        </label>
        {list("characterStateChanges", "Character state changes")}
        {list("locationStateChanges", "Location state changes")}
        <div className="md:col-span-2">{list("revealedFacts", "Important revealed facts")}</div>
      </div>
    </section>
  );
}
