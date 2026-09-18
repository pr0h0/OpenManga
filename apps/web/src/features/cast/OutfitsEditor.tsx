import { ImagePlus, Plus, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, patch, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import type { CharacterOutfitRow, Reference } from "../../api/types.ts";
import { Spinner } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";

export function OutfitsEditor({
  characterId,
  versionId,
  outfits,
  references,
  onChanged,
}: {
  characterId: string;
  versionId: string | null;
  outfits: CharacterOutfitRow[];
  /** This version's references: which outfits already have one, and whether the design itself is approved. */
  references: Reference[];
  onChanged: () => void;
}) {
  const withReference = new Set(references.map((r) => r.outfitId).filter((x): x is string => Boolean(x)));
  // An outfit reference re-dresses the approved design, so that has to exist before any outfit can be generated.
  const hasApprovedDesign = references.some((r) => !r.outfitId && (r.status === "approved" || r.status === "locked"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const opts = { onSuccess: onChanged };
  const add = useAction(
    () =>
      post(`/characters/${characterId}/outfits`, {
        name: name.trim(),
        description,
        isDefault: !outfits.length,
        characterVersionId: versionId,
      }),
    {
      onSuccess: () => {
        setName("");
        setDescription("");
        onChanged();
      },
    },
  );
  const update = useAction(
    ({ id, body }: { id: string; body: Partial<CharacterOutfitRow> }) => patch(`/character-outfits/${id}`, body),
    opts,
  );
  const remove = useAction((id: string) => del(`/character-outfits/${id}`), opts);
  const aiImage = useAiBody("image");
  const generate = useAction(
    (outfitId: string) =>
      post(`/character-versions/${versionId}/references/generate`, { kind: "outfit", outfitId, ...aiImage() }),
    { onSuccess: onChanged, success: "Outfit reference queued" },
  );
  return (
    <section className="card p-3">
      <h2 className="mb-2 text-sm font-semibold">Outfits</h2>
      {outfits.length > 0 && !hasApprovedDesign && (
        <p className="mb-2 rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          Generate and approve a main reference in <strong>Canonical references</strong> first. Outfit references are
          drawn from it, so the face and build stay identical across every outfit.
        </p>
      )}
      <ul className="space-y-2">
        {outfits.map((o) => (
          <li key={o.id} className="rounded-lg border border-[var(--border)] p-2">
            <div className="flex items-center gap-1">
              <input
                className="input py-1 text-sm font-medium"
                defaultValue={o.name}
                aria-label="Outfit name"
                onBlur={(e) =>
                  e.target.value.trim() &&
                  e.target.value !== o.name &&
                  update.mutate({ id: o.id, body: { name: e.target.value.trim() } })
                }
              />
              <button
                type="button"
                className="btn-ghost p-1"
                aria-label={o.isDefault ? "Default outfit" : "Make default"}
                title={o.isDefault ? "Default" : "Make default"}
                onClick={() => !o.isDefault && update.mutate({ id: o.id, body: { isDefault: true } })}
              >
                <Star className={`size-4 ${o.isDefault ? "fill-amber-400 text-amber-400" : ""}`} />
              </button>
              <button
                type="button"
                className="btn-ghost p-1"
                aria-label={`Generate a reference image for ${o.name}`}
                title={
                  !versionId
                    ? "No version selected"
                    : !hasApprovedDesign
                      ? "Generate and approve this character's main reference first — outfits are drawn from it so the face stays the same"
                      : withReference.has(o.id)
                        ? `Regenerate the reference for ${o.name}`
                        : `Generate a reference for ${o.name}`
                }
                disabled={!versionId || !hasApprovedDesign || generate.isPending}
                onClick={() => generate.mutate(o.id)}
              >
                {generate.isPending ? (
                  <Spinner />
                ) : withReference.has(o.id) ? (
                  <ImagePlus className="size-4 text-emerald-600" />
                ) : (
                  <ImagePlus className="size-4" />
                )}
              </button>
              <button
                type="button"
                className="btn-ghost p-1 text-red-500"
                aria-label="Delete outfit"
                onClick={() => remove.mutate(o.id)}
              >
                <Trash2 className="size-4" />
              </button>
            </div>
            <textarea
              className="input mt-1 min-h-12 text-xs"
              defaultValue={o.description}
              aria-label="Outfit description"
              onBlur={(e) =>
                e.target.value !== o.description && update.mutate({ id: o.id, body: { description: e.target.value } })
              }
            />
          </li>
        ))}
      </ul>
      <form
        className="mt-2 space-y-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <input
          className="input"
          placeholder="New outfit name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="New outfit name"
        />
        <textarea
          className="input min-h-12 text-xs"
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-label="New outfit description"
        />
        <button type="submit" className="btn-secondary w-full" disabled={!name.trim() || add.isPending}>
          <Plus className="size-4" /> Add outfit
        </button>
      </form>
    </section>
  );
}
