import { Link } from "@tanstack/react-router";
import { RotateCcw, Shirt, Star } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, put } from "../../../api/client.ts";
import { useAction } from "../../../api/hooks.ts";
import type { CharacterOutfitRow } from "../../../api/types.ts";
import { clsx } from "../../../components/ui.tsx";

export type OutfitChange = {
  id: string;
  characterId: string;
  outfitId: string;
  outfitName: string;
  panelId: string;
  scope: "onward" | "panel";
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  pageId: string;
  pageOrder: number;
  panelOrder: number;
};

export type PanelOutfits = {
  characters: {
    characterId: string;
    analysisKey: string | null;
    name: string;
    text: string;
    outfits: (CharacterOutfitRow & { referenceAssetId: string | null })[];
    worn: { outfitId: string; source: "panel" | "onward" | "text" | "default"; since: OutfitChange | null } | null;
    here: { id: string; scope: "onward" | "panel"; outfitId: string }[];
  }[];
};

/** "Ch.2 p.4 panel 1": where an outfit change was set, in reading order. */
export const changePlace = (c: OutfitChange) => `Ch.${c.chapterOrder} p.${c.pageOrder} panel ${c.panelOrder}`;

/**
 * Picks what a character wears on a panel, like picking the character itself: one chip per outfit, with its reference
 * image. A pick holds from this panel on (across pages and chapters, until the next change) or for this panel only.
 */
export function OutfitPicker({
  projectId,
  panelId,
  entry,
  locked,
  invalidate,
}: {
  projectId: string;
  panelId: string;
  entry: PanelOutfits["characters"][number];
  locked: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [scope, setScope] = useState<"onward" | "panel">("onward");
  const set = useAction(
    (outfitId: string) => put(`/panels/${panelId}/outfits`, { characterId: entry.characterId, outfitId, scope }),
    { invalidate },
  );
  const reset = useAction(
    async () => {
      for (const h of entry.here) await del(`/outfit-assignments/${h.id}`);
    },
    { invalidate },
  );
  if (!entry.outfits.length) return null;
  const w = entry.worn;
  const wornName = entry.outfits.find((o) => o.id === w?.outfitId)?.name;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex items-center gap-1">
        <span className="label mb-0 mr-auto flex items-center gap-1">
          <Shirt className="size-3.5" /> Outfit
        </span>
        <fieldset
          className="flex overflow-hidden rounded-md border border-[var(--border)] text-[11px]"
          aria-label="How long the pick holds"
        >
          {(
            [
              ["onward", "From this panel on"],
              ["panel", "Only this panel"],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              aria-pressed={scope === k}
              className={clsx("px-1.5 py-0.5", scope === k && "bg-accent-600/15 font-medium")}
              onClick={() => setScope(k)}
            >
              {label}
            </button>
          ))}
        </fieldset>
      </div>
      <fieldset className="flex flex-wrap gap-1" aria-label={`${entry.name} outfit`}>
        {entry.outfits.map((o) => {
          const on = w?.outfitId === o.id;
          return (
            <button
              key={o.id}
              type="button"
              aria-pressed={on}
              disabled={locked || set.isPending}
              title={o.description || o.name}
              onClick={() => set.mutate(o.id)}
              className={clsx(
                "chip flex items-center gap-1 border py-0.5 pl-0.5",
                on ? "border-accent-500 bg-accent-600/15" : "border-[var(--border)]",
              )}
            >
              {o.referenceAssetId ? (
                <img src={assetUrl(o.referenceAssetId, "thumbnail")} alt="" className="size-6 rounded object-cover" />
              ) : (
                <span className="grid size-6 place-items-center rounded bg-[var(--muted-bg,transparent)]">
                  <Shirt className="muted size-3.5" />
                </span>
              )}
              {o.name}
              {o.isDefault && <Star className="size-3 fill-amber-400 text-amber-400" aria-label="default" />}
            </button>
          );
        })}
      </fieldset>
      <div className="muted flex items-center gap-1 text-[11px]">
        <span className="mr-auto">
          {!w ? (
            entry.text ? (
              "Wearing what the outfit text says"
            ) : (
              "Wearing the wardrobe from the character's design"
            )
          ) : w.source === "panel" ? (
            <>Wearing {wornName} on this panel only</>
          ) : w.source === "onward" && w.since?.panelId === panelId ? (
            <>Wearing {wornName} from this panel on</>
          ) : w.source === "onward" && w.since ? (
            <>
              Wearing {wornName} since{" "}
              <Link
                to="/projects/$projectId/pages/$pageId"
                params={{ projectId, pageId: w.since.pageId }}
                search={{ panelId: w.since.panelId }}
                className="underline"
              >
                {changePlace(w.since)}
              </Link>
            </>
          ) : w.source === "text" ? (
            <>Wearing {wornName}, named in the outfit text</>
          ) : (
            <>Wearing {wornName}, the default outfit</>
          )}
        </span>
        {entry.here.length > 0 && (
          <button
            type="button"
            className="btn-ghost px-1 py-0 text-[11px]"
            disabled={locked || reset.isPending}
            title="Remove the outfit change set on this panel; it goes back to what it inherits"
            onClick={() => reset.mutate()}
          >
            <RotateCcw className="size-3" /> Reset
          </button>
        )}
      </div>
    </div>
  );
}
