import {
  outlineText,
  type ProjectConcept,
  ProjectConcept as ProjectConceptSchema,
  ProjectPremise,
  premiseDescription,
  StoryOutline,
  YoutubePackage,
} from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, ExternalLink, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import type { z } from "zod";
import { get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import { Field, Modal, Spinner, toast } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";
import { ManualAnswer } from "../generation/JobDetailPage.tsx";
import { CopyButton } from "../generation/shared.tsx";

export type ExpertAction = "concept" | "premise" | "outline" | "youtube";
export type Extraction = {
  id: string;
  messageId: string;
  projectId: string | null;
  action: ExpertAction;
  status: string;
  manual: boolean;
  result: Record<string, unknown> | null;
  failureReason: string | null;
  createdAt: string;
};

const ACTIONS: { action: ExpertAction; label: string; needsProject: boolean; title: string }[] = [
  { action: "concept", label: "New project", needsProject: false, title: "Start a new project from this concept" },
  { action: "premise", label: "Premise", needsProject: true, title: "Use as the project's premise (description)" },
  { action: "outline", label: "Outline", needsProject: true, title: "Save as an outline revision of the story" },
  { action: "youtube", label: "YouTube text", needsProject: true, title: "Use as the project's YouTube package text" },
];
const LABEL: Record<ExpertAction, string> = {
  concept: "New project",
  premise: "Premise",
  outline: "Outline",
  youtube: "YouTube text",
};
export const RUNNING = new Set(["queued", "processing", "submitted", "cancel_requested"]);

/**
 * Under an expert's reply: turn it into something applied. Each action first extracts a structured object (a text
 * job, with a key or pasted by hand), which is shown for review and editing; nothing changes until it is applied.
 */
export function ExpertActions({
  chatId,
  messageId,
  projectId,
  extractions,
}: {
  chatId: string;
  messageId: string;
  projectId: string | null;
  extractions: Extraction[];
}) {
  const aiText = useAiBody("text");
  const start = useAction(
    (action: ExpertAction) => post(`/expert-messages/${messageId}/extract`, { action, ...aiText() }),
    { invalidate: [["expert-chat", chatId]] },
  );
  // The newest run of each action: an older one was replaced by running it again.
  const latest = ACTIONS.map((a) => extractions.find((e) => e.action === a.action)).filter((e): e is Extraction =>
    Boolean(e),
  );
  return (
    <div className="mt-2 space-y-2">
      <div className="flex flex-wrap items-center gap-1 text-[11px]">
        <span className="muted inline-flex items-center gap-1">
          <Wand2 className="size-3" /> Use as
        </span>
        {ACTIONS.map((a) => {
          const off = a.needsProject && !projectId;
          return (
            <button
              key={a.action}
              type="button"
              className="chip border border-[var(--border)] disabled:opacity-50"
              disabled={off || start.isPending}
              title={off ? "Choose the project this chat is about first" : a.title}
              onClick={() => start.mutate(a.action)}
            >
              {a.label}
            </button>
          );
        })}
      </div>
      {latest.map((e) => (
        <ExtractionCard key={e.id} chatId={chatId} extraction={e} onRetry={() => start.mutate(e.action)} />
      ))}
    </div>
  );
}

function ExtractionCard({
  chatId,
  extraction: e,
  onRetry,
}: {
  chatId: string;
  extraction: Extraction;
  onRetry: () => void;
}) {
  const qc = useQueryClient();
  const [reviewing, setReviewing] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["expert-chat", chatId] });
  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{LABEL[e.action]}</span>
        {RUNNING.has(e.status) && (
          <span className="muted inline-flex items-center gap-1">
            <Spinner /> Reading the reply…
          </span>
        )}
        {e.status === "completed" && (
          <button type="button" className="btn-primary px-2 py-0.5 text-xs" onClick={() => setReviewing(true)}>
            <Check className="size-3.5" /> Review and apply
          </button>
        )}
        {(e.status === "failed" || e.status === "cancelled") && (
          <>
            <span className="text-red-500">{e.failureReason ?? `The extraction ${e.status}.`}</span>
            <button type="button" className="btn-ghost px-1 py-0 text-xs" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {e.projectId && (
          <Link
            to="/projects/$projectId/generation/$jobId"
            params={{ projectId: e.projectId, jobId: e.id }}
            className="muted ml-auto inline-flex items-center gap-1 hover:underline"
          >
            Job <ExternalLink className="size-3" />
          </Link>
        )}
      </div>
      {e.status === "awaiting_input" && <PasteStep jobId={e.id} onSubmitted={refresh} />}
      {reviewing && e.result && (
        <Review chatId={chatId} extraction={e} result={e.result} onClose={() => setReviewing(false)} />
      )}
    </div>
  );
}

/** Paste mode: copy the extraction prompt into any chat and paste its JSON back, checked like a provider's answer. */
function PasteStep({ jobId, onSubmitted }: { jobId: string; onSubmitted: () => void }) {
  const manual = useQuery({
    queryKey: [...qk.job(jobId), "manual-prompt"],
    queryFn: () =>
      get<{ prompt: string; lastError: string | null; attachments: string[]; answered: number }>(
        `/generations/${jobId}/manual`,
      ),
  });
  if (!manual.data) return <Spinner className="mt-2" />;
  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <span className="muted">Copy this prompt into any chat, then paste its reply below.</span>
        <CopyButton text={manual.data.prompt} label="Copy prompt" />
      </div>
      <ManualAnswer
        jobId={jobId}
        lastError={manual.data.lastError}
        attachments={manual.data.attachments}
        answered={manual.data.answered}
        onSubmitted={onSubmitted}
      />
    </div>
  );
}

const lines = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

/** Checks an edited result against the schema the extraction used, and says what is wrong in words. */
function checked<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const i = r.error.issues[0];
  toast.error(`${i?.path.join(".") || "Value"}: ${i?.message ?? "invalid"}`);
  return null;
}

function Review({
  chatId,
  extraction: e,
  result,
  onClose,
}: {
  chatId: string;
  extraction: Extraction;
  result: Record<string, unknown>;
  onClose: () => void;
}) {
  const title = {
    concept: "New project from this concept",
    premise: "Replace the project's premise",
    outline: "Save as an outline revision",
    youtube: "Replace the YouTube package text",
  }[e.action];
  return (
    <Modal open onClose={onClose} title={title} wide>
      <p className="muted mb-3 text-xs">
        Read through what was taken from the reply and change anything you like. Nothing is changed until you apply it.
      </p>
      {e.action === "concept" && <ConceptForm chatId={chatId} value={result as ProjectConcept} onDone={onClose} />}
      {e.action === "premise" && e.projectId && (
        <PremiseForm projectId={e.projectId} value={result as { logline: string; premise: string }} onDone={onClose} />
      )}
      {e.action === "outline" && e.projectId && (
        <OutlineForm projectId={e.projectId} value={result as z.infer<typeof StoryOutline>} onDone={onClose} />
      )}
      {e.action === "youtube" && e.projectId && (
        <YoutubeForm projectId={e.projectId} value={result as z.infer<typeof YoutubePackage>} onDone={onClose} />
      )}
    </Modal>
  );
}

function ConceptForm({ chatId, value, onDone }: { chatId: string; value: ProjectConcept; onDone: () => void }) {
  const navigate = useNavigate();
  const [v, setV] = useState(value);
  const [attach, setAttach] = useState(true);
  const set = (k: keyof ProjectConcept) => (x: { target: { value: string } }) => setV({ ...v, [k]: x.target.value });
  const create = useAction(
    async () => {
      const c = checked(ProjectConceptSchema, v);
      if (!c) return null;
      const { project } = await post<{ project: { id: string } }>("/projects", {
        title: c.title,
        description: premiseDescription(c),
        projectType: c.projectType,
        format: c.format,
        story: { content: c.storyIdea, inputKind: "idea", title: c.title },
      });
      if (attach) await patch(`/expert-chats/${chatId}`, { projectId: project.id });
      return project;
    },
    {
      invalidate: [["projects"], ["expert-chats"], ["expert-chat", chatId]],
      onSuccess: (project) => {
        if (!project) return;
        toast.success("Project created");
        onDone();
        navigate({ to: "/projects/$projectId", params: { projectId: project.id } });
      },
    },
  );
  return (
    <div className="space-y-3">
      <Field label="Title">
        <input className="input" value={v.title} onChange={set("title")} />
      </Field>
      <Field label="Logline">
        <input className="input" value={v.logline} onChange={set("logline")} />
      </Field>
      <Field label="Premise" hint="With the logline, this becomes the project description.">
        <textarea className="input min-h-28 text-sm" value={v.premise} onChange={set("premise")} />
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Type">
          <select className="input" value={v.projectType} onChange={set("projectType")}>
            {["manhwa", "manga", "webtoon", "comic", "illustrated_story"].map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ")}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Format">
          <select className="input" value={v.format} onChange={set("format")}>
            <option value="comic">Comic pages</option>
            <option value="film">Film (16:9 shots)</option>
            <option value="vertical">Vertical strip</option>
          </select>
        </Field>
      </div>
      <Field label="Story idea" hint="Saved as the project's first story revision, to analyse or develop.">
        <textarea className="input min-h-40 text-sm" value={v.storyIdea} onChange={set("storyIdea")} />
      </Field>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={attach} onChange={(x) => setAttach(x.target.checked)} />
        Continue this chat about the new project
      </label>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? <Spinner /> : <Plus className="size-4" />} Create project
        </button>
      </div>
    </div>
  );
}

function PremiseForm({
  projectId,
  value,
  onDone,
}: {
  projectId: string;
  value: { logline: string; premise: string };
  onDone: () => void;
}) {
  const [v, setV] = useState(value);
  const current = useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => get<{ project: { description: string } }>(`/projects/${projectId}`),
  });
  const save = useAction(
    async () => {
      const p = checked(ProjectPremise, v);
      if (p) await patch(`/projects/${projectId}`, { description: premiseDescription(p) });
      return Boolean(p);
    },
    {
      invalidate: [qk.project(projectId)],
      onSuccess: (ok) => {
        if (!ok) return;
        toast.success("Project description replaced");
        onDone();
      },
    },
  );
  return (
    <div className="space-y-3">
      <Field label="Logline">
        <input className="input" value={v.logline} onChange={(x) => setV({ ...v, logline: x.target.value })} />
      </Field>
      <Field label="Premise">
        <textarea
          className="input min-h-32 text-sm"
          value={v.premise}
          onChange={(x) => setV({ ...v, premise: x.target.value })}
        />
      </Field>
      {current.data?.project.description && (
        <details className="text-xs">
          <summary className="muted cursor-pointer">The description it replaces</summary>
          <p className="mt-1 whitespace-pre-wrap">{current.data.project.description}</p>
        </details>
      )}
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : <Check className="size-4" />} Replace description
        </button>
      </div>
    </div>
  );
}

function OutlineForm({
  projectId,
  value,
  onDone,
}: {
  projectId: string;
  value: z.infer<typeof StoryOutline>;
  onDone: () => void;
}) {
  const [v, setV] = useState(value);
  const setChapter = (i: number, k: "title" | "summary", x: string) =>
    setV({ ...v, chapters: v.chapters.map((c, n) => (n === i ? { ...c, [k]: x } : c)) });
  const save = useAction(
    async () => {
      const o = checked(StoryOutline, v);
      if (o)
        await post(`/projects/${projectId}/story/revisions`, {
          content: outlineText(o),
          title: o.title,
          inputKind: "outline",
        });
      return Boolean(o);
    },
    {
      invalidate: [qk.project(projectId)],
      onSuccess: (ok) => {
        if (!ok) return;
        toast.success("Outline saved as a new story revision");
        onDone();
      },
    },
  );
  return (
    <div className="space-y-3">
      <Field label="Revision title">
        <input className="input" value={v.title} onChange={(x) => setV({ ...v, title: x.target.value })} />
      </Field>
      <ol className="space-y-2">
        {v.chapters.map((c, i) => (
          <li key={i} className="rounded-lg border border-[var(--border)] p-2">
            <div className="flex items-center gap-2">
              <span className="muted text-xs">{i + 1}.</span>
              <input
                className="input flex-1"
                aria-label={`Chapter ${i + 1} title`}
                value={c.title}
                onChange={(x) => setChapter(i, "title", x.target.value)}
              />
              <button
                type="button"
                className="btn-ghost p-1.5 text-red-500"
                aria-label={`Remove chapter ${i + 1}`}
                disabled={v.chapters.length === 1}
                onClick={() => setV({ ...v, chapters: v.chapters.filter((_, n) => n !== i) })}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
            <textarea
              className="input mt-1 min-h-16 text-sm"
              aria-label={`Chapter ${i + 1} summary`}
              value={c.summary}
              onChange={(x) => setChapter(i, "summary", x.target.value)}
            />
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap justify-between gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setV({ ...v, chapters: [...v.chapters, { title: "", summary: "" }] })}
        >
          <Plus className="size-4" /> Chapter
        </button>
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : <Check className="size-4" />} Save outline
        </button>
      </div>
    </div>
  );
}

function YoutubeForm({
  projectId,
  value,
  onDone,
}: {
  projectId: string;
  value: z.infer<typeof YoutubePackage>;
  onDone: () => void;
}) {
  const [titles, setTitles] = useState(value.titles.join("\n"));
  const [description, setDescription] = useState(value.description);
  const [tags, setTags] = useState(value.tags.join(", "));
  const [pinnedComment, setPinnedComment] = useState(value.pinnedComment);
  const [headlines, setHeadlines] = useState(value.thumbnailHeadlines.join("\n"));
  const save = useAction(
    async () => {
      const y = checked(YoutubePackage, {
        titles: lines(titles),
        description,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        pinnedComment,
        thumbnailHeadlines: lines(headlines),
      });
      if (y) await patch(`/projects/${projectId}`, { settings: { youtubePackage: y } });
      return Boolean(y);
    },
    {
      invalidate: [qk.project(projectId)],
      onSuccess: (ok) => {
        if (!ok) return;
        toast.success("YouTube package text replaced");
        onDone();
      },
    },
  );
  return (
    <div className="space-y-3">
      <Field label="Titles" hint="One per line, strongest first.">
        <textarea className="input min-h-20 text-sm" value={titles} onChange={(x) => setTitles(x.target.value)} />
      </Field>
      <Field label="Description">
        <textarea
          className="input min-h-32 text-sm"
          value={description}
          onChange={(x) => setDescription(x.target.value)}
        />
      </Field>
      <Field label="Tags" hint="Comma separated.">
        <input className="input" value={tags} onChange={(x) => setTags(x.target.value)} />
      </Field>
      <Field label="Pinned comment">
        <input className="input" value={pinnedComment} onChange={(x) => setPinnedComment(x.target.value)} />
      </Field>
      <Field label="Thumbnail headlines" hint="One per line.">
        <textarea className="input min-h-16 text-sm" value={headlines} onChange={(x) => setHeadlines(x.target.value)} />
      </Field>
      <div className="flex justify-end">
        <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : <Check className="size-4" />} Replace YouTube text
        </button>
      </div>
    </div>
  );
}
