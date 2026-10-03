import { useQuery } from "@tanstack/react-query";
import { get } from "../../api/client.ts";
import { clsx, ErrorBox, Spinner } from "../../components/ui.tsx";

type Work = { pages: number; drawnPanels: number };
type Named = { added: string[]; removed: { id: string; name: string }[] };
export type Diff = {
  hasExisting: boolean;
  chapters: {
    kept: ({ id: string; title: string; textChanged: boolean } & Work)[];
    renamed: ({ id: string; from: string; to: string } & Work)[];
    added: { title: string; position: number }[];
    removed: ({ id: string; title: string } & Work)[];
  };
  characters: Named;
  locations: Named;
  props: Named;
};

/** What a re-analysis drops, as ids the user can confirm deleting after it is applied. */
export type Removals = { chapters: string[]; characters: string[]; locations: string[]; props: string[] };
export const NO_REMOVALS: Removals = { chapters: [], characters: [], locations: [], props: [] };

const work = (w: Work) => (w.pages ? ` — ${w.pages} page(s), ${w.drawnPanels} drawn panel(s)` : " — no pages yet");

export const useAnalysisDiff = (analysisId: string, enabled = true) =>
  useQuery({
    queryKey: ["analysis-diff", analysisId],
    queryFn: () => get<{ diff: Diff }>(`/story-analyses/${analysisId}/diff`),
    select: (r) => r.diff,
    enabled,
  });

/**
 * What applying an analysis would change in a project that already has chapters: chapters kept, renamed, added and no
 * longer in the story; characters, places and props added or no longer mentioned. Applying keeps everything; what the
 * story dropped can be ticked here for removal, which is confirmed separately.
 */
export function AnalysisDiff({
  analysisId,
  removals,
  onRemovals,
}: {
  analysisId: string;
  /** Without these the list is read-only (the production run card shows it this way). */
  removals?: Removals;
  onRemovals?: (r: Removals) => void;
}) {
  const q = useAnalysisDiff(analysisId);
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  if (!d?.hasExisting) return null;
  const toggle = (kind: keyof Removals, id: string) =>
    removals &&
    onRemovals?.({
      ...removals,
      [kind]: removals[kind].includes(id) ? removals[kind].filter((x) => x !== id) : [...removals[kind], id],
    });
  const removable = (kind: keyof Removals, id: string, label: string) => (
    <li key={id}>
      {removals ? (
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={removals[kind].includes(id)}
            onChange={() => toggle(kind, id)}
          />
          <span>{label}</span>
        </label>
      ) : (
        label
      )}
    </li>
  );
  const nothing =
    !d.chapters.renamed.length &&
    !d.chapters.added.length &&
    !d.chapters.removed.length &&
    !d.chapters.kept.some((c) => c.textChanged) &&
    (["characters", "locations", "props"] as const).every((k) => !d[k].added.length && !d[k].removed.length);
  return (
    <div className="space-y-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <div>
        <h3 className="font-medium">What this analysis changes in the project</h3>
        <p className="muted text-xs">
          Applying keeps every chapter that is already there, with its pages and artwork, and adds what is new. Nothing
          is removed unless you tick it below and confirm.
        </p>
      </div>
      {nothing && <p className="muted text-xs">Nothing changes: the project already matches this analysis.</p>}
      <Section title="New chapters" items={d.chapters.added.map((c) => `${c.position}. ${c.title}`)} />
      <Section title="Renamed chapters" items={d.chapters.renamed.map((c) => `${c.from} → ${c.to}${work(c)}`)} />
      <Section
        title="Chapters whose story text changed (pages are kept; once applied, choose for each to keep its pages or re-plan it)"
        items={d.chapters.kept.filter((c) => c.textChanged).map((c) => `${c.title}${work(c)}`)}
      />
      {d.chapters.removed.length > 0 && (
        <div>
          <div className="text-xs font-medium">Chapters no longer in the story (kept unless ticked)</div>
          <ul className="space-y-0.5 text-xs">
            {d.chapters.removed.map((c) => removable("chapters", c.id, `${c.title}${work(c)}`))}
          </ul>
        </div>
      )}
      {(["characters", "locations", "props"] as const).map((k) => (
        <div key={k} className={clsx(!d[k].added.length && !d[k].removed.length && "hidden")}>
          <div className="text-xs font-medium capitalize">{k === "locations" ? "places" : k}</div>
          {d[k].added.length > 0 && <p className="text-xs">New: {d[k].added.join(", ")}</p>}
          {d[k].removed.length > 0 && (
            <>
              <p className="text-xs">No longer in the story (kept unless ticked; ticked ones go to the trash):</p>
              <ul className="space-y-0.5 text-xs">{d[k].removed.map((r) => removable(k, r.id, r.name))}</ul>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="text-xs font-medium">{title}</div>
      <ul className="list-inside list-disc text-xs">
        {items.map((i) => (
          <li key={i}>{i}</li>
        ))}
      </ul>
    </div>
  );
}
