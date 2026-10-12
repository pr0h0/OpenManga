import type { TimelineExtraction } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, Baby, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  toast,
} from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

type Event = {
  id: string;
  order: number;
  kind: "event" | "birth";
  title: string;
  description: string;
  when: string;
  day: number | null;
  chapterId: string | null;
  sceneNumber: number | null;
  characterIds: string[];
  since: number | null;
  elapsed: string | null;
  outOfOrder: boolean;
  ages: Record<string, number>;
};
type Data = {
  events: Event[];
  chapters: { id: string; order: number; title: string }[];
  characters: { id: string; name: string }[];
  states: { id: string; characterId: string; kind: string; text: string; eventId: string | null }[];
  extraction: {
    id: string;
    status: string;
    result: { data?: TimelineExtraction; applied?: unknown } | null;
    failureReason: string | null;
  } | null;
};

const key = (projectId: string) => ["project", projectId, "timeline"] as const;
const fmtDay = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(2).replace(/0+$/, ""));

/**
 * The story timeline: what happens in story-time order (a flashback where it happened), with elapsed time, ages and
 * the chapter that tells each event. The bible's character states show at the event they start from.
 */
export function TimelinePage() {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: key(projectId), queryFn: () => get<Data>(`/projects/${projectId}/timeline`) });
  const [edit, setEdit] = useState<Event | "new" | null>(null);
  const [removing, setRemoving] = useState<Event | null>(null);
  const [extracting, setExtracting] = useState(false);
  const d = q.data;
  const refresh = () => qc.invalidateQueries({ queryKey: key(projectId) });
  const move = async (i: number, by: -1 | 1) => {
    if (!d) return;
    const ids = d.events.map((e) => e.id);
    [ids[i], ids[i + by]] = [ids[i + by]!, ids[i]!];
    try {
      await post(`/projects/${projectId}/timeline/order`, { ids });
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const name = (id: string) => d?.characters.find((c) => c.id === id)?.name ?? "?";
  const chapter = (id: string | null) => d?.chapters.find((c) => c.id === id);
  const statesAt = (eventId: string | null) => d?.states.filter((s) => s.eventId === eventId) ?? [];
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title="Story timeline"
        subtitle="What happens in story-time order, not the order chapters tell it: a flashback sits where it happened. Story days give elapsed time and, with a birth, ages; bible states show where they start."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setExtracting(true)}>
              <Sparkles className="size-4" /> Extract from story
            </button>
            <button type="button" className="btn-primary" onClick={() => setEdit("new")}>
              <Plus className="size-4" /> Add event
            </button>
          </>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {d && (
        <>
          <Review key={d.extraction?.id} data={d} onDone={refresh} />
          {!d.events.length && (
            <EmptyState title="No events yet">
              Add the story's events in the order they happen, or extract them from the chapters.
            </EmptyState>
          )}
          {statesAt(null).length > 0 && d.events.length > 0 && (
            <StatesHere label="From the start" states={statesAt(null)} name={name} />
          )}
          <ol className="space-y-1" aria-label="Timeline">
            {d.events.map((e, i) => {
              const ch = chapter(e.chapterId);
              return (
                <li key={e.id}>
                  {e.outOfOrder ? (
                    <div className="py-1 pl-4 text-xs text-amber-700 dark:text-amber-300">
                      Day {e.day !== null ? fmtDay(e.day) : "?"} is earlier than an event above it: move it, or fix its
                      day
                    </div>
                  ) : (
                    e.elapsed &&
                    e.since !== null &&
                    e.since > 0 && <div className="muted py-1 pl-4 text-xs">{e.elapsed} later</div>
                  )}
                  <article className="card flex gap-3 p-3" aria-label={e.title}>
                    <div className="flex flex-col">
                      <button
                        type="button"
                        className="btn-ghost p-1"
                        aria-label={`Move ${e.title} earlier`}
                        disabled={i === 0}
                        onClick={() => move(i, -1)}
                      >
                        <ArrowUp className="size-3.5" />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost p-1"
                        aria-label={`Move ${e.title} later`}
                        disabled={i === d.events.length - 1}
                        onClick={() => move(i, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </button>
                    </div>
                    <div className="min-w-0 flex-1 space-y-1 text-sm">
                      <div className="flex flex-wrap items-baseline gap-x-2">
                        {e.kind === "birth" && <Baby className="size-3.5 self-center" aria-label="birth" />}
                        <span className="font-medium">{e.title}</span>
                        {e.when && <span className="muted text-xs">{e.when}</span>}
                        {e.day !== null && <span className="muted text-xs">· day {fmtDay(e.day)}</span>}
                      </div>
                      {e.description && <p className="muted text-xs">{e.description}</p>}
                      <div className="flex flex-wrap gap-1 text-xs">
                        {ch && (
                          <Link
                            to="/projects/$projectId/chapters/$chapterId"
                            params={{ projectId, chapterId: ch.id }}
                            className="chip hover:underline"
                          >
                            ch. {ch.order}
                            {e.sceneNumber ? `, scene ${e.sceneNumber}` : ""}
                          </Link>
                        )}
                        {e.characterIds.map((c) => (
                          <span key={c} className="chip">
                            {name(c)}
                            {e.ages[c] !== undefined && `, ${e.ages[c]}`}
                          </span>
                        ))}
                      </div>
                      {statesAt(e.id).length > 0 && <StatesHere states={statesAt(e.id)} name={name} />}
                    </div>
                    <div className="flex items-start gap-1">
                      <button
                        type="button"
                        className="btn-ghost p-1.5"
                        aria-label={`Edit ${e.title}`}
                        onClick={() => setEdit(e)}
                      >
                        <Pencil className="size-4" />
                      </button>
                      <button
                        type="button"
                        className="btn-ghost p-1.5 text-red-500"
                        aria-label={`Delete ${e.title}`}
                        onClick={() => setRemoving(e)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </article>
                </li>
              );
            })}
          </ol>
          {edit && <EventForm data={d} event={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
          {extracting && <ExtractDialog data={d} onClose={() => setExtracting(false)} />}
          <ConfirmDialog
            open={Boolean(removing)}
            title={`Delete "${removing?.title ?? ""}"?`}
            confirmLabel="Delete"
            danger
            onClose={() => setRemoving(null)}
            onConfirm={async () => {
              try {
                await del(`/timeline-events/${removing!.id}`);
                await refresh();
              } catch (e) {
                toast.error(e);
              }
              setRemoving(null);
            }}
          >
            It is removed from the timeline. Chapters and the bible are not touched.
          </ConfirmDialog>
        </>
      )}
    </div>
  );
}

function StatesHere({ label, states, name }: { label?: string; states: Data["states"]; name: (id: string) => string }) {
  return (
    <div className="rounded-md bg-[var(--panel-2)] p-2 text-xs">
      {label && <div className="mb-1 font-medium">{label}</div>}
      <ul className="space-y-0.5">
        {states.map((s) => (
          <li key={s.id}>
            <span className="font-medium">{name(s.characterId)}</span> <span className="muted">({s.kind})</span>{" "}
            {s.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

function EventForm({ data, event, onClose }: { data: Data; event: Event | null; onClose: () => void }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const [f, setF] = useState({
    kind: event?.kind ?? ("event" as Event["kind"]),
    title: event?.title ?? "",
    when: event?.when ?? "",
    day: event?.day ?? null,
    description: event?.description ?? "",
    chapterId: event?.chapterId ?? null,
    sceneNumber: event?.sceneNumber ?? null,
    characterIds: event?.characterIds ?? [],
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const b = { ...f, sceneNumber: f.chapterId ? f.sceneNumber : null };
      if (event) await patch(`/timeline-events/${event.id}`, b);
      else await post(`/projects/${projectId}/timeline/events`, b);
      await qc.invalidateQueries({ queryKey: key(projectId) });
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={event ? "Edit event" : "Add event"}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || !f.title.trim()} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <Field label="What happens">
          <input
            className="input"
            value={f.title}
            maxLength={200}
            onChange={(e) => setF({ ...f, title: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="When" hint="In the story's words: “Spring 1203”, “the night of the storm”.">
            <input
              className="input"
              value={f.when}
              maxLength={120}
              onChange={(e) => setF({ ...f, when: e.target.value })}
            />
          </Field>
          <Field label="Story day" hint="One scale for the whole story; later is larger. Gives elapsed time and ages.">
            <input
              className="input"
              type="number"
              step="any"
              value={f.day ?? ""}
              onChange={(e) => setF({ ...f, day: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </Field>
          <Field label="Kind">
            <select
              className="input"
              value={f.kind}
              onChange={(e) => setF({ ...f, kind: e.target.value as Event["kind"] })}
            >
              <option value="event">Event</option>
              <option value="birth">Birth (gives an age)</option>
            </select>
          </Field>
        </div>
        <Field label="Details">
          <textarea
            className="input min-h-16"
            value={f.description}
            maxLength={1000}
            onChange={(e) => setF({ ...f, description: e.target.value })}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Told in">
            <select
              className="input"
              value={f.chapterId ?? ""}
              onChange={(e) => setF({ ...f, chapterId: e.target.value || null })}
            >
              <option value="">Not told (only mentioned)</option>
              {data.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  ch. {c.order}: {c.title}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Scene number">
            <input
              className="input"
              type="number"
              min={1}
              disabled={!f.chapterId}
              value={f.sceneNumber ?? ""}
              onChange={(e) => setF({ ...f, sceneNumber: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </Field>
        </div>
        <fieldset>
          <legend className="label">Who</legend>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {data.characters.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={f.characterIds.includes(c.id)}
                  onChange={(e) =>
                    setF({
                      ...f,
                      characterIds: e.target.checked
                        ? [...f.characterIds, c.id]
                        : f.characterIds.filter((x) => x !== c.id),
                    })
                  }
                />
                {c.name}
              </label>
            ))}
            {!data.characters.length && <span className="muted text-xs">No characters yet.</span>}
          </div>
        </fieldset>
      </div>
    </Modal>
  );
}

function ExtractDialog({ data, onClose }: { data: Data; onClose: () => void }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [chapterId, setChapterId] = useState("");
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await post(`/projects/${projectId}/timeline/extract`, { ...aiText(), chapterId: chapterId || undefined });
      await qc.invalidateQueries({ queryKey: key(projectId) });
      toast.success("Extraction queued");
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Extract timeline from story"
      footer={
        <>
          <AiChip cap="text" className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || !data.chapters.length} onClick={run}>
            {busy && <Spinner />} Extract
          </button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p>
          The text model reads the chapters and proposes their events in story-time order, with dates and story days
          where the text gives them, and births where it gives ages. Nothing is saved until you review it.
        </p>
        {!data.chapters.length && (
          <p className="text-amber-600">Analyse and apply the story first: there are no chapters.</p>
        )}
        <Field label="Chapters">
          <select className="input" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">All chapters</option>
            {data.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                ch. {c.order}: {c.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Modal>
  );
}

/** The latest extraction: running, waiting for a pasted answer, failed, or a proposal to review and apply. */
function Review({ data, onDone }: { data: Data; onDone: () => void }) {
  const projectId = useProjectId();
  const x = data.extraction;
  const proposal = x?.result?.data;
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  if (!x || x.result?.applied) return null;
  if (x.status !== "completed")
    return (
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3 text-sm">
        <span>Timeline extraction</span>
        <StatusChip status={x.status} />
        {x.status === "failed" && <span className="muted">{x.failureReason}</span>}
        {x.status === "awaiting_input" && (
          <Link className="underline" to="/projects/$projectId/generation/$jobId" params={{ projectId, jobId: x.id }}>
            Paste the answer
          </Link>
        )}
      </div>
    );
  if (!proposal) return null;
  const keep = proposal.events.length - skip.size;
  const apply = async (save: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ events: number; skipped: { entry: string; reason: string }[] }>(
        `/timeline-extractions/${x.id}/apply`,
        { events: save ? proposal.events.filter((_, i) => !skip.has(i)) : [] },
      );
      onDone();
      if (save)
        toast.success(
          `Saved ${r.events} events${r.skipped.length ? `; ${r.skipped.length} names or chapters not found (${r.skipped[0]!.reason})` : ""}`,
        );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card mb-4 space-y-3 p-3" aria-label="Review the extracted timeline">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Review the extracted timeline</h2>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => apply(false)}>
          Discard
        </button>
        <button type="button" className="btn-primary" disabled={busy || keep === 0} onClick={() => apply(true)}>
          {busy && <Spinner />} Save {keep} events
        </button>
      </div>
      <p className="muted text-xs">Untick what you do not want. Dated events are merged in by their day.</p>
      <ul className="space-y-1 text-sm">
        {proposal.events.map((e, i) => (
          <li key={i}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={!skip.has(i)}
                onChange={() => {
                  const next = new Set(skip);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  setSkip(next);
                }}
              />
              <span>
                {e.kind === "birth" && <Baby className="mr-1 inline size-3.5" aria-label="birth" />}
                <strong>{e.title}</strong>{" "}
                <span className="muted text-xs">
                  {[
                    e.when,
                    e.day != null && `day ${fmtDay(e.day)}`,
                    e.chapter && `ch. ${e.chapter}${e.scene ? `, scene ${e.scene}` : ""}`,
                    e.characters.join(", "),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}
