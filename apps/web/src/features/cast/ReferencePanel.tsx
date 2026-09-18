import { Link } from "@tanstack/react-router";
import { ExternalLink, ImagePlus, Lock, Sparkles, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { api, assetUrl, del, errorMessage, post } from "../../api/client.ts";
import { onProjectEvent, useAction } from "../../api/hooks.ts";
import type { CharacterOutfitRow, Reference } from "../../api/types.ts";
import { AssetImage, ConfirmDialog, EmptyState, fmt, Modal, Spinner, StatusChip, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

export type Subject = "character" | "location" | "prop" | "style";

const KINDS: Record<Subject, string[]> = {
  character: ["portrait", "full_body", "multi_angle", "expression_sheet", "outfit"],
  location: ["location"],
  prop: ["prop"],
  style: ["style"],
};

type Pending = { jobId: string; status: string; failureReason?: string | null };

export function ReferencePanel({
  subject,
  versionPath,
  versionId,
  versionStatus,
  references,
  outfits,
  onChanged,
}: {
  subject: Subject;
  versionPath: string;
  versionId: string;
  versionStatus: string;
  references: Reference[];
  outfits?: CharacterOutfitRow[];
  onChanged: () => void;
}) {
  const projectId = useProjectId();
  const kinds = KINDS[subject];
  const [kind, setKind] = useState(kinds[0]!);
  const [outfitId, setOutfitId] = useState("");
  /** Outfits that already have a reference, so the dropdown says which are still to do. */
  const outfitsWithReference = new Set(
    (references ?? []).map((r) => r.outfitId).filter((x): x is string => Boolean(x)),
  );
  /** An outfit reference is drawn from the approved design, so that has to exist before any outfit can be run. */
  const hasApprovedIdentity = (references ?? []).some(
    (r) => !r.outfitId && (r.status === "approved" || r.status === "locked"),
  );
  const needsBaseline = subject === "character" && kind === "outfit" && !hasApprovedIdentity;
  const [extra, setExtra] = useState("");
  const [pending, setPending] = useState<Pending[]>([]);
  const [viewing, setViewing] = useState<Reference | null>(null);
  const [trashing, setTrashing] = useState<Reference | null>(null);
  const [uploading, setUploading] = useState(false);
  const mine = references.filter(
    (r) => (r.characterVersionId ?? r.locationVersionId ?? r.propVersionId ?? r.projectStyleId) === versionId,
  );
  const superseded = versionStatus === "superseded";

  useEffect(() => {
    const off = onProjectEvent((e) => {
      if (e.type !== "job.updated" || e.targetId !== versionId || !String(e.kind).endsWith("_reference")) return;
      const jobId = String(e.jobId);
      setPending((list) => {
        const others = list.filter((p) => p.jobId !== jobId);
        if (e.status === "completed" || e.status === "cancelled") return others;
        return [...others, { jobId, status: String(e.status), failureReason: e.failureReason as string | null }];
      });
      if (e.status === "completed") onChanged();
    });
    return () => {
      off();
    };
  }, [versionId, onChanged]);

  const aiImage = useAiBody("image");
  const generate = useAction(
    () =>
      post<{ job: { id: string } }>(`/${versionPath}/${versionId}/references/generate`, {
        ...aiImage(),
        kind,
        extraInstruction: extra.trim() || undefined,
        outfitId: kind === "outfit" && outfitId ? outfitId : undefined,
      }),
    {
      onSuccess: (r) => setPending((p) => [...p, { jobId: r.job.id, status: "queued" }]),
      success: "Reference generation queued",
    },
  );
  const setStatus = useAction(
    ({ id, status }: { id: string; status: string }) => post(`/references/${id}/status`, { status }),
    { onSuccess: onChanged },
  );
  const primary = useAction((id: string) => post(`/references/${id}/primary`), { onSuccess: onChanged });
  const trash = useAction((id: string) => del(`/references/${id}`), {
    onSuccess: () => {
      setTrashing(null);
      onChanged();
    },
    success: "Reference moved to trash",
  });

  const upload = async (file: File) => {
    const form = new FormData();
    form.set("file", file);
    form.set("kind", kinds.length > 1 ? kind : "uploaded");
    setUploading(true);
    try {
      await api(`/${versionPath}/${versionId}/references/upload`, { method: "POST", body: form });
      toast.success("Reference uploaded");
      onChanged();
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };

  return (
    <section className="card p-4" aria-label="References">
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <h2 className="mr-auto font-semibold">Canonical references</h2>
        {kinds.length > 1 && (
          <label>
            <span className="label">Kind</span>
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {k.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          </label>
        )}
        {kind === "outfit" && outfits && (
          <label>
            <span className="label">Outfit</span>
            <select className="input" value={outfitId} onChange={(e) => setOutfitId(e.target.value)}>
              <option value="">Default wardrobe</option>
              {outfits.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                  {outfitsWithReference.has(o.id) ? " ✓" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="min-w-48 flex-1">
          <span className="label">Extra instruction (optional)</span>
          <input
            className="input"
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="e.g. slightly smiling"
          />
        </label>
        <AiChip cap="image" />
        <button
          type="button"
          className="btn-primary"
          disabled={superseded || generate.isPending || needsBaseline}
          title={
            needsBaseline
              ? "Generate and approve a main reference first — outfits are drawn from it so the face stays the same"
              : undefined
          }
          onClick={() => generate.mutate()}
        >
          {generate.isPending ? <Spinner /> : <Sparkles className="size-4" />} Generate
        </button>
        <label
          className={`btn-secondary cursor-pointer ${superseded || uploading ? "pointer-events-none opacity-50" : ""}`}
        >
          {uploading ? <Spinner /> : <ImagePlus className="size-4" />} Upload
          <input
            type="file"
            className="sr-only"
            accept="image/png,image/jpeg,image/webp"
            disabled={superseded || uploading}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) upload(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
      <p className="muted mb-3 text-xs">
        References are generated at full resolution and kept as the canonical identity source. Approving one creates a
        small prompt derivative that is attached to later panel requests.
      </p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-4">
        {pending.map((p) => (
          <div
            key={p.jobId}
            className="flex aspect-[3/4] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-[var(--border)] p-3 text-center text-sm"
          >
            {p.status === "failed" ? (
              <>
                <span className="text-red-500">Generation failed</span>
                <span className="muted text-xs">{p.failureReason}</span>
                <div className="flex gap-1">
                  <Link
                    to="/projects/$projectId/generation/$jobId"
                    params={{ projectId, jobId: p.jobId }}
                    className="btn-ghost text-xs"
                  >
                    Inspect
                  </Link>
                  <button
                    type="button"
                    className="btn-ghost text-xs"
                    onClick={() => setPending((l) => l.filter((x) => x.jobId !== p.jobId))}
                  >
                    Dismiss
                  </button>
                </div>
              </>
            ) : (
              <>
                <Spinner className="size-6" />
                <span>Generating full-resolution reference…</span>
                <StatusChip status={p.status} />
              </>
            )}
          </div>
        ))}
        {mine.map((r) => {
          const d = r.promptDerivatives[0];
          const active = r.status === "approved" || r.status === "locked";
          return (
            <div key={r.id} className="overflow-hidden rounded-lg border border-[var(--border)]">
              <button
                type="button"
                className="block w-full"
                onClick={() => setViewing(r)}
                aria-label="View full resolution"
              >
                <AssetImage
                  assetId={r.asset.id}
                  alt={`${r.kind} reference`}
                  className="aspect-[3/4] w-full"
                  fit="contain"
                />
              </button>
              <div className="space-y-1.5 p-2 text-xs">
                <div className="flex items-center gap-1">
                  <span className="font-medium capitalize">{r.kind.replace(/_/g, " ")}</span>
                  {r.isPrimary && <Star className="size-3.5 fill-amber-400 text-amber-400" aria-label="Primary" />}
                  <span className="ml-auto flex items-center gap-1">
                    {r.stale && (
                      <span
                        className="chip bg-amber-500/15 text-amber-600"
                        title="Made from an older description. The image still shows the old look and is attached to every panel; regenerate it."
                      >
                        stale
                      </span>
                    )}
                    <StatusChip status={r.status} />
                  </span>
                </div>
                <div className="muted">
                  {r.asset.width}×{r.asset.height} canonical · {fmt.bytes(r.asset.byteSize)}
                </div>
                <div className="muted">
                  {d
                    ? `prompt ref ${d.width}×${d.height} · ${fmt.bytes(d.byteSize)}`
                    : "derivative created on approval"}
                </div>
                <div className="flex flex-wrap gap-1 pt-1">
                  {r.status === "draft" && (
                    <button
                      type="button"
                      className="btn-secondary px-2 py-1 text-xs"
                      onClick={() => setStatus.mutate({ id: r.id, status: "approved" })}
                    >
                      Approve
                    </button>
                  )}
                  {r.status === "approved" && (
                    <>
                      <button
                        type="button"
                        className="btn-secondary px-2 py-1 text-xs"
                        onClick={() => setStatus.mutate({ id: r.id, status: "locked" })}
                      >
                        <Lock className="size-3" /> Lock
                      </button>
                      <button
                        type="button"
                        className="btn-ghost px-2 py-1 text-xs"
                        onClick={() => setStatus.mutate({ id: r.id, status: "draft" })}
                      >
                        Unapprove
                      </button>
                    </>
                  )}
                  {!r.isPrimary && active && (
                    <button type="button" className="btn-ghost px-2 py-1 text-xs" onClick={() => primary.mutate(r.id)}>
                      <Star className="size-3" /> Primary
                    </button>
                  )}
                  {r.asset.generationJobId && (
                    <Link
                      to="/projects/$projectId/generation/$jobId"
                      params={{ projectId, jobId: r.asset.generationJobId }}
                      className="btn-ghost px-2 py-1 text-xs"
                      title="Prompt inspector"
                    >
                      <ExternalLink className="size-3" />
                    </Link>
                  )}
                  {r.status !== "locked" && (
                    <button
                      type="button"
                      className="btn-ghost ml-auto px-2 py-1 text-xs text-red-500"
                      onClick={() => setTrashing(r)}
                      aria-label="Trash reference"
                    >
                      <Trash2 className="size-3" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {!mine.length && !pending.length && (
        <EmptyState title="No references yet">
          Generate one with the image AI (full resolution) or upload your own.
        </EmptyState>
      )}

      <Modal
        open={Boolean(viewing)}
        onClose={() => setViewing(null)}
        title={viewing ? `${viewing.kind.replace(/_/g, " ")} — ${viewing.asset.width}×${viewing.asset.height}` : ""}
        wide="xl"
      >
        {viewing && (
          <img
            src={assetUrl(viewing.asset.id)}
            alt="Full resolution reference"
            className="mx-auto max-h-[65vh] object-contain"
          />
        )}
      </Modal>
      <ConfirmDialog
        open={Boolean(trashing)}
        title="Trash reference?"
        danger
        confirmLabel="Move to trash"
        busy={trash.isPending}
        onClose={() => setTrashing(null)}
        onConfirm={() => trashing && trash.mutate(trashing.id)}
      >
        The image moves to the asset trash and will no longer be used as an identity reference.
      </ConfirmDialog>
      {setStatus.error && <p className="mt-2 text-xs text-red-500">{errorMessage(setStatus.error)}</p>}
    </section>
  );
}
