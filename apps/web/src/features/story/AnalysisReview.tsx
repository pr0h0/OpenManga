import type { StoryAnalysis } from "@openmanga/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { del, patch, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { StoryAnalysisRow } from "../../api/types.ts";
import { ConfirmDialog, Field, Spinner, StatusChip, TagInput, toast } from "../../components/ui.tsx";
import { AnalysisDiff, NO_REMOVALS, type Removals, useAnalysisDiff } from "./AnalysisDiff.tsx";

type Char = StoryAnalysis["characters"][number];

/** Review + edit the structured analysis before it becomes cast/world/chapters. Nothing is applied until confirmed. */
export function AnalysisReview({
  analysis,
  projectId,
  onApplied,
}: {
  analysis: StoryAnalysisRow;
  projectId: string;
  onApplied?: (created: Record<string, number>) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<StoryAnalysis | null>(analysis.result as StoryAnalysis | null);
  const [busy, setBusy] = useState<"save" | "apply" | null>(null);
  const [removals, setRemovals] = useState<Removals>(NO_REMOVALS);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setDraft(analysis.result as StoryAnalysis | null), [analysis.id, analysis.result]);
  useEffect(() => setRemovals(NO_REMOVALS), [analysis.id]);
  const diff = useAnalysisDiff(analysis.id, analysis.status !== "applied");
  if (!draft) return <p className="muted text-sm">This analysis has no result.</p>;
  const applied = analysis.status === "applied";
  const set = <K extends keyof StoryAnalysis>(k: K, v: StoryAnalysis[K]) => setDraft({ ...draft, [k]: v });
  const setChar = (i: number, c: Partial<Char>) =>
    set(
      "characters",
      draft.characters.map((x, j) => (j === i ? { ...x, ...c } : x)),
    );
  const setBible = (i: number, b: Partial<Char["bible"]>) =>
    setChar(i, { bible: { ...draft.characters[i]!.bible, ...b } });

  const save = async () => {
    setBusy("save");
    try {
      await patch(`/story-analyses/${analysis.id}`, { result: draft });
      await qc.invalidateQueries({ queryKey: qk.story(projectId) });
      toast.success("Analysis edits saved");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const ticked = Object.values(removals).flat().length;
  const apply = async () => {
    setConfirming(false);
    setBusy("apply");
    try {
      const r = await post<{ created: Record<string, number> }>(`/story-analyses/${analysis.id}/apply`, {
        result: draft,
      });
      // What the user confirmed removing goes through the ordinary delete routes, with their own safeguards (a
      // chapter with generation in progress is refused; cast and places go to the trash).
      const failed: string[] = [];
      for (const [kind, path] of [
        ["chapters", "chapters"],
        ["characters", "characters"],
        ["locations", "locations"],
        ["props", "props"],
      ] as const)
        for (const id of removals[kind]) await del(`/${path}/${id}`).catch((e) => failed.push(String(e?.message ?? e)));
      if (failed.length) toast.error(`${failed.length} removal(s) were refused: ${failed[0]}`);
      setRemovals(NO_REMOVALS);
      for (const key of [
        qk.story(projectId),
        qk.cast(projectId),
        qk.locations(projectId),
        qk.props(projectId),
        qk.chapters(projectId),
        qk.project(projectId),
        ["analysis-diff", analysis.id],
      ])
        await qc.invalidateQueries({ queryKey: key });
      toast.success(
        `Created ${r.created.characters} characters, ${r.created.locations} locations, ${r.created.props} props, ${r.created.chapters} chapters`,
      );
      onApplied?.(r.created);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip status={analysis.status} />
        <span className="muted text-xs">
          Edit anything below. Applying creates draft records you can keep refining; existing characters with the same
          name are not duplicated.
        </span>
        <div className="ml-auto flex gap-2">
          <button type="button" className="btn-secondary" onClick={save} disabled={busy !== null}>
            {busy === "save" && <Spinner />} Save edits
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => (ticked ? setConfirming(true) : apply())}
            disabled={busy !== null}
          >
            {busy === "apply" ? <Spinner /> : <Check className="size-4" />}{" "}
            {applied ? "Apply again" : "Apply to project"}
          </button>
        </div>
      </div>

      {!applied && <AnalysisDiff analysisId={analysis.id} removals={removals} onRemovals={setRemovals} />}
      <ConfirmDialog
        open={confirming}
        title="Apply and remove?"
        confirmLabel={`Apply and remove ${ticked}`}
        danger
        onClose={() => setConfirming(false)}
        onConfirm={() => void apply()}
      >
        <p className="mb-2">The analysis is applied, then these are removed:</p>
        <ul className="list-inside list-disc text-sm">
          {diff.data?.chapters.removed
            .filter((c) => removals.chapters.includes(c.id))
            .map((c) => (
              <li key={c.id}>
                Chapter “{c.title}”, deleted with its {c.pages} page(s) and {c.drawnPanels} drawn panel(s)
              </li>
            ))}
          {(["characters", "locations", "props"] as const).flatMap((k) =>
            (diff.data?.[k].removed ?? [])
              .filter((r) => removals[k].includes(r.id))
              .map((r) => <li key={r.id}>{r.name}, moved to the trash with its reference images</li>),
          )}
        </ul>
      </ConfirmDialog>

      <section className="card space-y-3 p-4">
        <h3 className="font-medium">Summary</h3>
        <textarea
          className="input min-h-20"
          value={draft.summary}
          onChange={(e) => set("summary", e.target.value)}
          aria-label="Summary"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Genre">
            <input className="input" value={draft.genre} onChange={(e) => set("genre", e.target.value)} />
          </Field>
          <Field label="Subgenre">
            <input className="input" value={draft.subgenre} onChange={(e) => set("subgenre", e.target.value)} />
          </Field>
          <Field label="Tone">
            <input className="input" value={draft.tone} onChange={(e) => set("tone", e.target.value)} />
          </Field>
          <Field label="Setting">
            <input className="input" value={draft.setting} onChange={(e) => set("setting", e.target.value)} />
          </Field>
          <Field label="Period">
            <input className="input" value={draft.period} onChange={(e) => set("period", e.target.value)} />
          </Field>
          <Field label="Pacing">
            <input className="input" value={draft.pacing} onChange={(e) => set("pacing", e.target.value)} />
          </Field>
        </div>
        <Field label="Themes">
          <TagInput value={draft.themes} onChange={(v) => set("themes", v)} />
        </Field>
        <Field label="Visual motifs">
          <TagInput value={draft.visualMotifs} onChange={(v) => set("visualMotifs", v)} />
        </Field>
        <Field label="World rules">
          <TagInput value={draft.world.worldRules} onChange={(v) => set("world", { ...draft.world, worldRules: v })} />
        </Field>
      </section>

      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="font-medium">Characters ({draft.characters.length})</h3>
          <button
            type="button"
            className="btn-secondary"
            onClick={() =>
              set("characters", [
                ...draft.characters,
                {
                  key: `character-${draft.characters.length + 1}`,
                  name: "New character",
                  aliases: [],
                  role: "supporting",
                  bible: draft.characters[0]?.bible
                    ? { ...draft.characters[0].bible, summary: "", immutableTraits: [], distinctiveFeatures: [] }
                    : ({} as Char["bible"]),
                },
              ])
            }
          >
            <Plus className="size-4" /> Add
          </button>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {draft.characters.map((c, i) => (
            <div key={`${c.key}-${i}`} className="rounded-lg border border-[var(--border)] p-3">
              <div className="flex gap-2">
                <input
                  className="input font-medium"
                  value={c.name}
                  onChange={(e) => setChar(i, { name: e.target.value })}
                  aria-label="Character name"
                />
                <select
                  className="input w-36"
                  value={c.role}
                  onChange={(e) => setChar(i, { role: e.target.value as Char["role"] })}
                  aria-label="Role"
                >
                  {["protagonist", "antagonist", "supporting", "minor"].map((r) => (
                    <option key={r}>{r}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-ghost text-red-500"
                  aria-label={`Remove ${c.name}`}
                  onClick={() =>
                    set(
                      "characters",
                      draft.characters.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
              <div className="mt-2 space-y-2">
                <Field label="Aliases (resolved to this character)">
                  <TagInput value={c.aliases} onChange={(v) => setChar(i, { aliases: v })} />
                </Field>
                <Field label="Summary">
                  <textarea
                    className="input min-h-14"
                    value={c.bible.summary}
                    onChange={(e) => setBible(i, { summary: e.target.value })}
                  />
                </Field>
                <div className="grid grid-cols-2 gap-2">
                  <Field label="Hair">
                    <input
                      className="input"
                      value={c.bible.hair}
                      onChange={(e) => setBible(i, { hair: e.target.value })}
                    />
                  </Field>
                  <Field label="Eyes">
                    <input
                      className="input"
                      value={c.bible.eyes}
                      onChange={(e) => setBible(i, { eyes: e.target.value })}
                    />
                  </Field>
                  <Field label="Age">
                    <input
                      className="input"
                      value={c.bible.ageRange}
                      onChange={(e) => setBible(i, { ageRange: e.target.value })}
                    />
                  </Field>
                  <Field label="Build">
                    <input
                      className="input"
                      value={c.bible.build}
                      onChange={(e) => setBible(i, { build: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="Wardrobe">
                  <input
                    className="input"
                    value={c.bible.wardrobe}
                    onChange={(e) => setBible(i, { wardrobe: e.target.value })}
                  />
                </Field>
                <Field label="Immutable traits">
                  <TagInput value={c.bible.immutableTraits} onChange={(v) => setBible(i, { immutableTraits: v })} />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h3 className="mb-2 font-medium">Locations ({draft.locations.length})</h3>
          <ul className="space-y-2">
            {draft.locations.map((l, i) => (
              <li key={`${l.key}-${i}`} className="flex gap-2">
                <input
                  className="input"
                  value={l.name}
                  onChange={(e) =>
                    set(
                      "locations",
                      draft.locations.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                    )
                  }
                  aria-label="Location name"
                />
                <button
                  type="button"
                  className="btn-ghost text-red-500"
                  aria-label={`Remove ${l.name}`}
                  onClick={() =>
                    set(
                      "locations",
                      draft.locations.filter((_, j) => j !== i),
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
          <h3 className="mt-4 mb-2 font-medium">Recurring props</h3>
          <ul className="space-y-1 text-sm">
            {draft.props.map((p, i) => (
              <li key={`${p.key}-${i}`} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={p.recurring}
                  onChange={(e) =>
                    set(
                      "props",
                      draft.props.map((x, j) => (j === i ? { ...x, recurring: e.target.checked } : x)),
                    )
                  }
                  aria-label={`${p.name} is recurring`}
                />
                {p.name}
              </li>
            ))}
            {!draft.props.length && <li className="muted">None detected</li>}
          </ul>
        </div>
        <div className="card p-4">
          <h3 className="mb-2 font-medium">Chapters ({draft.chapters.length})</h3>
          <ol className="space-y-2">
            {draft.chapters.map((c, i) => (
              <li key={i} className="space-y-1">
                <input
                  className="input font-medium"
                  value={c.title}
                  onChange={(e) =>
                    set(
                      "chapters",
                      draft.chapters.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)),
                    )
                  }
                  aria-label="Chapter title"
                />
                <p className="muted text-xs">{c.summary}</p>
              </li>
            ))}
          </ol>
          <h3 className="mt-4 mb-2 font-medium">Major plot beats</h3>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {draft.plotBeats.map((b, i) => (
              <li key={i}>{b.summary}</li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
