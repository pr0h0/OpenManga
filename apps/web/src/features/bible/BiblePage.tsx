import {
  BIBLE_FACT_KINDS,
  type BibleExtraction,
  CHARACTER_STATE_KINDS,
  type CharacterStateKind,
} from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Eye, Lock, Pencil, Plus, Sparkles, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import type { BibleFactRow, CharacterStateRow } from "../../api/types.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Tabs,
  toast,
} from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { ContinuityQueue, RuleChecks } from "./Continuity.tsx";

type Chapter = { id: string; order: number; title: string };
type Character = { id: string; name: string; role: string; outfits: { id: string; name: string }[] };
type Extraction = {
  id: string;
  status: string;
  input: { chapterId?: string | null };
  result: { data?: BibleExtraction; applied?: { at: string; facts: number; states: number } } | null;
  failureReason: string | null;
  createdAt: string;
};
export type BibleData = {
  facts: BibleFactRow[];
  states: CharacterStateRow[];
  chapters: Chapter[];
  characters: Character[];
  extraction: Extraction | null;
};

export const bibleKey = (projectId: string) => ["project", projectId, "bible"] as const;
export const useBible = (projectId: string) =>
  useQuery({ queryKey: bibleKey(projectId), queryFn: () => get<BibleData>(`/projects/${projectId}/bible`) });

const chapterLabel = (chs: Chapter[], id: string | null) => {
  const c = chs.find((x) => x.id === id);
  return c ? `ch. ${c.order}` : null;
};

/** "ch. 3–11", "from ch. 7", "until ch. 12" or "whole story". */
function rangeText(chs: Chapter[], from: string | null, until: string | null) {
  const [a, b] = [chapterLabel(chs, from), chapterLabel(chs, until)];
  if (a && b) return a === b ? a : `${a}–${b.replace("ch. ", "")}`;
  if (a) return `from ${a}`;
  if (b) return `until ${b}`;
  return "whole story";
}

/** The story bible: canon that planning, narration and image prompts must respect. */
export function BiblePage() {
  const projectId = useProjectId();
  const q = useBible(projectId);
  const [tab, setTab] = useState<"facts" | "timeline" | "continuity" | "rules">("facts");
  const [editFact, setEditFact] = useState<BibleFactRow | "new" | null>(null);
  const [editState, setEditState] = useState<CharacterStateRow | "new" | null>(null);
  const [extracting, setExtracting] = useState(false);
  const d = q.data;
  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Story bible"
        subtitle="Canon that chapter planning, panel prompts, narration and panel images must respect, from the chapter it starts in."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setExtracting(true)}>
              <Sparkles className="size-4" /> Extract from story
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => (tab === "timeline" ? setEditState("new") : setEditFact("new"))}
            >
              <Plus className="size-4" /> {tab === "timeline" ? "Add state" : "Add fact"}
            </button>
          </>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {d && (
        <>
          <ExtractionPanel key={d.extraction?.id} data={d} />
          <Tabs
            value={tab}
            onChange={setTab}
            tabs={[
              { value: "facts", label: `Facts (${d.facts.length})` },
              { value: "timeline", label: `Character timeline (${d.states.length})` },
              { value: "continuity", label: "Continuity" },
              { value: "rules", label: "Rule checks" },
            ]}
          />
          {tab === "facts" && <FactList data={d} onEdit={setEditFact} />}
          {tab === "timeline" && <Timeline data={d} onEdit={setEditState} />}
          {tab === "continuity" && <ContinuityQueue data={d} />}
          {tab === "rules" && <RuleChecks data={d} />}
          {editFact && (
            <FactForm data={d} fact={editFact === "new" ? null : editFact} onClose={() => setEditFact(null)} />
          )}
          {editState && (
            <StateForm data={d} state={editState === "new" ? null : editState} onClose={() => setEditState(null)} />
          )}
          {extracting && <ExtractDialog data={d} onClose={() => setExtracting(false)} />}
        </>
      )}
    </div>
  );
}

function FactList({ data, onEdit }: { data: BibleData; onEdit: (f: BibleFactRow) => void }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const [kind, setKind] = useState("");
  const [fixedOnly, setFixedOnly] = useState(false);
  const [chapterId, setChapterId] = useState("");
  const [search, setSearch] = useState("");
  const [removing, setRemoving] = useState<BibleFactRow | null>(null);
  const orderOf = (id: string | null) => data.chapters.find((c) => c.id === id)?.order ?? null;
  const at = orderOf(chapterId || null);
  const shown = data.facts.filter((f) => {
    if (kind && f.kind !== kind) return false;
    if (fixedOnly && !f.fixed) return false;
    if (at !== null) {
      const [a, b] = [orderOf(f.fromChapterId), orderOf(f.untilChapterId)];
      if ((a !== null && a > at) || (b !== null && b < at)) return false;
    }
    const s = search.trim().toLowerCase();
    return !s || `${f.subject} ${f.text}`.toLowerCase().includes(s);
  });
  const remove = async (f: BibleFactRow) => {
    try {
      await del(`/bible-facts/${f.id}`);
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
      setRemoving(null);
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <>
      <div className="mb-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
        <Field label="Kind">
          <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {BIBLE_FACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="In effect at">
          <select className="input" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">Any chapter</option>
            {data.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                Chapter {c.order}: {c.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search">
          <input
            className="input"
            value={search}
            placeholder="Subject or text"
            onChange={(e) => setSearch(e.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={fixedOnly} onChange={(e) => setFixedOnly(e.target.checked)} /> Fixed rules
          only
        </label>
      </div>
      {!data.facts.length ? (
        <EmptyState title="No facts yet">
          Add facts by hand, or extract them from the story. A fixed fact is a rule every step must keep ("scar on the
          LEFT jaw", "no guns exist in this world").
        </EmptyState>
      ) : !shown.length ? (
        <p className="muted text-sm">Nothing matches these filters.</p>
      ) : (
        <ul className="space-y-2">
          {shown.map((f) => (
            <li key={f.id} className="card flex items-start gap-3 p-3">
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="chip">{f.kind}</span>
                  {f.fixed && (
                    <span className="chip" title="Fixed: a rule that must hold">
                      <Lock className="size-3" /> fixed
                    </span>
                  )}
                  {f.visual && (
                    <span className="chip" title="Visual: reaches image prompts">
                      <Eye className="size-3" /> visual
                    </span>
                  )}
                  <span className="muted">{rangeText(data.chapters, f.fromChapterId, f.untilChapterId)}</span>
                  {f.source !== "user" && <span className="muted">· {f.source}</span>}
                </div>
                <p className="text-sm">
                  {f.subject && <strong>{f.subject}: </strong>}
                  {f.text}
                </p>
              </div>
              <button type="button" className="btn-ghost p-1" aria-label="Edit fact" onClick={() => onEdit(f)}>
                <Pencil className="size-4" />
              </button>
              <button type="button" className="btn-ghost p-1" aria-label="Delete fact" onClick={() => setRemoving(f)}>
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={Boolean(removing)}
        title="Delete fact"
        danger
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      >
        Later generation will no longer be told: “{removing?.text}”.
      </ConfirmDialog>
    </>
  );
}

function Timeline({ data, onEdit }: { data: BibleData; onEdit: (s: CharacterStateRow) => void }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const [who, setWho] = useState("");
  const [removing, setRemoving] = useState<CharacterStateRow | null>(null);
  const orderOf = (id: string | null) => data.chapters.find((c) => c.id === id)?.order ?? 0;
  const cast = data.characters.filter((c) => data.states.some((s) => s.characterId === c.id));
  const shown = cast.filter((c) => !who || c.id === who);
  const remove = async (s: CharacterStateRow) => {
    try {
      await del(`/character-states/${s.id}`);
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
      setRemoving(null);
    } catch (e) {
      toast.error(e);
    }
  };
  if (!data.states.length)
    return (
      <EmptyState title="No character states yet">
        A state holds for one character from a chapter (and scene) on: an injury, a look, the outfit in force, what they
        carry, where they are, their rank, what they know.
      </EmptyState>
    );
  return (
    <>
      <div className="mb-3 max-w-xs">
        <Field label="Character">
          <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">Everyone</option>
            {cast.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="space-y-4">
        {shown.map((c) => (
          <section key={c.id} className="card p-3">
            <h2 className="mb-2 font-medium">{c.name}</h2>
            <ol className="space-y-2 border-l border-[var(--border)] pl-3">
              {data.states
                .filter((s) => s.characterId === c.id)
                .sort(
                  (a, b) =>
                    orderOf(a.chapterId) - orderOf(b.chapterId) ||
                    (a.sceneNumber ?? 0) - (b.sceneNumber ?? 0) ||
                    a.createdAt.localeCompare(b.createdAt),
                )
                .map((s) => (
                  <li key={s.id} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="muted flex flex-wrap items-center gap-1.5 text-xs">
                        <span className="chip">{s.kind}</span>
                        <span>
                          {chapterLabel(data.chapters, s.chapterId) ?? "from the start"}
                          {s.sceneNumber ? `, scene ${s.sceneNumber}` : ""}
                          {s.untilChapterId ? ` → until ${chapterLabel(data.chapters, s.untilChapterId)}` : ""}
                        </span>
                        {s.outfitId && <span>· outfit: {c.outfits.find((o) => o.id === s.outfitId)?.name}</span>}
                      </div>
                      <p className="text-sm">{s.text}</p>
                    </div>
                    <button type="button" className="btn-ghost p-1" aria-label="Edit state" onClick={() => onEdit(s)}>
                      <Pencil className="size-4" />
                    </button>
                    <button
                      type="button"
                      className="btn-ghost p-1"
                      aria-label="Delete state"
                      onClick={() => setRemoving(s)}
                    >
                      <Trash2 className="size-4" />
                    </button>
                  </li>
                ))}
            </ol>
          </section>
        ))}
      </div>
      <p className="muted mt-3 text-xs">
        A later look, outfit, location or rank replaces the earlier one; injuries, items, knowledge and other states
        hold until their end chapter. An outfit state that names an outfit dresses the character in it wherever no panel
        sets another.
      </p>
      <ConfirmDialog
        open={Boolean(removing)}
        title="Delete state"
        danger
        confirmLabel="Delete"
        onClose={() => setRemoving(null)}
        onConfirm={() => removing && remove(removing)}
      >
        Remove “{removing?.text}” from the timeline?
      </ConfirmDialog>
    </>
  );
}

function ChapterSelect({
  label,
  data,
  value,
  onChange,
  none,
}: {
  label: string;
  data: BibleData;
  value: string | null;
  onChange: (v: string | null) => void;
  none: string;
}) {
  return (
    <Field label={label}>
      <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{none}</option>
        {data.chapters.map((c) => (
          <option key={c.id} value={c.id}>
            Chapter {c.order}: {c.title}
          </option>
        ))}
      </select>
    </Field>
  );
}

export type FactDraft = Pick<
  BibleFactRow,
  "kind" | "subject" | "text" | "fixed" | "visual" | "fromChapterId" | "untilChapterId"
>;

/** Add or edit a fact; `onSubmit` replaces the save (explaining a continuity finding saves through its own route). */
export function FactForm({
  data,
  fact,
  onClose,
  title,
  initial,
  onSubmit,
}: {
  data: BibleData;
  fact: BibleFactRow | null;
  onClose: () => void;
  title?: string;
  initial?: Partial<FactDraft>;
  onSubmit?: (f: FactDraft) => Promise<unknown>;
}) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const [f, setF] = useState<FactDraft>({
    kind: fact?.kind ?? initial?.kind ?? "character",
    subject: fact?.subject ?? initial?.subject ?? "",
    text: fact?.text ?? initial?.text ?? "",
    fixed: fact?.fixed ?? false,
    visual: fact?.visual ?? false,
    fromChapterId: fact?.fromChapterId ?? initial?.fromChapterId ?? null,
    untilChapterId: fact?.untilChapterId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (onSubmit) await onSubmit(f);
      else if (fact) await patch(`/bible-facts/${fact.id}`, f);
      else await post(`/projects/${projectId}/bible/facts`, f);
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
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
      title={title ?? (fact ? "Edit fact" : "Add fact")}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || !f.text.trim()} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Kind">
          <select
            className="input"
            value={f.kind}
            onChange={(e) => setF({ ...f, kind: e.target.value as typeof f.kind })}
          >
            {BIBLE_FACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject" hint="Who or what it is about, by name. Empty for the whole story.">
          <input
            className="input"
            list="bible-subjects"
            value={f.subject}
            onChange={(e) => setF({ ...f, subject: e.target.value })}
          />
          <datalist id="bible-subjects">
            {data.characters.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Fact">
            <textarea
              className="input min-h-20"
              maxLength={1000}
              value={f.text}
              onChange={(e) => setF({ ...f, text: e.target.value })}
            />
          </Field>
        </div>
        <ChapterSelect
          label="From chapter"
          data={data}
          value={f.fromChapterId}
          none="The start"
          onChange={(v) => setF({ ...f, fromChapterId: v })}
        />
        <ChapterSelect
          label="Through chapter"
          data={data}
          value={f.untilChapterId}
          none="The end"
          onChange={(v) => setF({ ...f, untilChapterId: v })}
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={f.fixed} onChange={(e) => setF({ ...f, fixed: e.target.checked })} />
          <span>
            <strong>Fixed</strong> — a rule every step must keep, checked as a rule.
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={f.visual} onChange={(e) => setF({ ...f, visual: e.target.checked })} />
          <span>
            <strong>Visual</strong> — it can be seen, so panel images are told too.
          </span>
        </label>
      </div>
    </Modal>
  );
}

function StateForm({
  data,
  state,
  onClose,
}: {
  data: BibleData;
  state: CharacterStateRow | null;
  onClose: () => void;
}) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const [s, setS] = useState({
    characterId: state?.characterId ?? data.characters[0]?.id ?? "",
    kind: (state?.kind ?? "injury") as CharacterStateKind,
    text: state?.text ?? "",
    chapterId: state?.chapterId ?? null,
    sceneNumber: state?.sceneNumber ?? null,
    untilChapterId: state?.untilChapterId ?? null,
    outfitId: state?.outfitId ?? null,
  });
  const [busy, setBusy] = useState(false);
  const outfits = data.characters.find((c) => c.id === s.characterId)?.outfits ?? [];
  const save = async () => {
    setBusy(true);
    try {
      const b = {
        ...s,
        sceneNumber: s.chapterId ? s.sceneNumber : null,
        outfitId: s.kind === "outfit" ? s.outfitId : null,
      };
      if (state) await patch(`/character-states/${state.id}`, b);
      else await post(`/projects/${projectId}/bible/states`, b);
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  if (!data.characters.length)
    return (
      <Modal open onClose={onClose} title="Add state">
        <p className="text-sm">The project has no characters yet. Add the cast first.</p>
      </Modal>
    );
  return (
    <Modal
      open
      onClose={onClose}
      title={state ? "Edit state" : "Add state"}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={busy || !s.text.trim()} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Character">
          <select
            className="input"
            value={s.characterId}
            onChange={(e) => setS({ ...s, characterId: e.target.value, outfitId: null })}
          >
            {data.characters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Kind">
          <select
            className="input"
            value={s.kind}
            onChange={(e) => setS({ ...s, kind: e.target.value as CharacterStateKind })}
          >
            {CHARACTER_STATE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="State">
            <textarea
              className="input min-h-16"
              maxLength={1000}
              value={s.text}
              onChange={(e) => setS({ ...s, text: e.target.value })}
            />
          </Field>
        </div>
        {s.kind === "outfit" && (
          <Field label="Outfit" hint="Naming one of their outfits dresses them in it, reference image included.">
            <select
              className="input"
              value={s.outfitId ?? ""}
              onChange={(e) => setS({ ...s, outfitId: e.target.value || null })}
            >
              <option value="">None (text only)</option>
              {outfits.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ChapterSelect
          label="From chapter"
          data={data}
          value={s.chapterId}
          none="The start"
          onChange={(v) => setS({ ...s, chapterId: v })}
        />
        <Field label="From scene" hint="Scene number in that chapter; empty for its start.">
          <input
            className="input"
            type="number"
            min={1}
            disabled={!s.chapterId}
            value={s.sceneNumber ?? ""}
            onChange={(e) => setS({ ...s, sceneNumber: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <ChapterSelect
          label="Through chapter"
          data={data}
          value={s.untilChapterId}
          none="Until replaced, or the end"
          onChange={(v) => setS({ ...s, untilChapterId: v })}
        />
      </div>
    </Modal>
  );
}

function ExtractDialog({ data, onClose }: { data: BibleData; onClose: () => void }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [chapterId, setChapterId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await post(`/projects/${projectId}/bible/extract`, { ...aiText(), chapterId: chapterId ?? undefined });
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
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
      title="Extract bible from story"
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
          The text model reads the chapters and their chapter memory and proposes facts and character states. Nothing is
          saved until you review the proposal and apply what you keep.
        </p>
        {!data.chapters.length && (
          <p className="text-amber-600">Analyse and apply the story first: there are no chapters.</p>
        )}
        <ChapterSelect label="Chapters" data={data} value={chapterId} none="All chapters" onChange={setChapterId} />
      </div>
    </Modal>
  );
}

/** The latest extraction: running, waiting for a pasted answer, failed, or a proposal to review and apply. */
function ExtractionPanel({ data }: { data: BibleData }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const x = data.extraction;
  const proposal = x?.result?.data;
  const [skipFacts, setSkipFacts] = useState<Set<number>>(new Set());
  const [skipStates, setSkipStates] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const toggle = (set: Set<number>, i: number) => {
    const next = new Set(set);
    if (next.has(i)) next.delete(i);
    else next.add(i);
    return next;
  };
  const counts = useMemo(
    () => ({
      facts: (proposal?.facts.length ?? 0) - skipFacts.size,
      states: (proposal?.states.length ?? 0) - skipStates.size,
    }),
    [proposal, skipFacts, skipStates],
  );
  if (!x || x.result?.applied) return null;
  const apply = async (keep: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ facts: number; states: number; skipped: { entry: string; reason: string }[] }>(
        `/bible-extractions/${x.id}/apply`,
        keep
          ? {
              facts: proposal?.facts.filter((_, i) => !skipFacts.has(i)) ?? [],
              states: proposal?.states.filter((_, i) => !skipStates.has(i)) ?? [],
            }
          : { facts: [], states: [] },
      );
      await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
      if (keep)
        toast.success(
          `Saved ${r.facts} facts and ${r.states} states${r.skipped.length ? `; skipped ${r.skipped.length} (${r.skipped[0]!.reason})` : ""}`,
        );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  if (x.status !== "completed")
    return (
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3 text-sm">
        <span>Bible extraction</span>
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
  const chapterNo = (n?: number | null) => (n ? `ch. ${n}` : null);
  return (
    <section className="card mb-4 space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Review the extracted bible</h2>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => apply(false)}>
          Discard
        </button>
        <button
          type="button"
          className="btn-primary"
          disabled={busy || counts.facts + counts.states === 0}
          onClick={() => apply(true)}
        >
          {busy && <Spinner />} Save {counts.facts} facts, {counts.states} states
        </button>
      </div>
      <p className="muted text-xs">Untick what you do not want. You can edit everything once saved.</p>
      <div className="grid gap-3 md:grid-cols-2">
        <ul className="space-y-1 text-sm">
          {proposal.facts.map((f, i) => (
            <li key={i}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={!skipFacts.has(i)}
                  onChange={() => setSkipFacts(toggle(skipFacts, i))}
                />
                <span>
                  <span className="chip mr-1 text-xs">{f.kind}</span>
                  {f.fixed && <Lock className="mr-1 inline size-3" aria-label="fixed" />}
                  {f.subject && <strong>{f.subject}: </strong>}
                  {f.text}{" "}
                  <span className="muted text-xs">
                    {[
                      chapterNo(f.fromChapter) && `from ${chapterNo(f.fromChapter)}`,
                      chapterNo(f.untilChapter) && `until ${chapterNo(f.untilChapter)}`,
                    ]
                      .filter(Boolean)
                      .join(", ")}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        <ul className="space-y-1 text-sm">
          {proposal.states.map((s, i) => (
            <li key={i}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  checked={!skipStates.has(i)}
                  onChange={() => setSkipStates(toggle(skipStates, i))}
                />
                <span>
                  <strong>{s.character}</strong> <span className="chip mx-1 text-xs">{s.kind}</span>
                  {s.text}{" "}
                  <span className="muted text-xs">
                    {chapterNo(s.fromChapter) ?? "from the start"}
                    {s.fromScene ? `, scene ${s.fromScene}` : ""}
                  </span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
