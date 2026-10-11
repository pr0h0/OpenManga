import { IMAGE_ASPECTS, type ImageAspectKey } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagePlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, del, get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { CastCard, LocationCard, PropCard } from "../../api/types.ts";
import { AssetImage, EmptyState, ErrorBox, PageHeader, Spinner, StatusChip, toast } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { useLocationStates } from "../world/LocationStates.tsx";

export type BoardItem = {
  id: string;
  assetId: string;
  note: string;
  width: number | null;
  height: number | null;
  described: {
    jobId: string;
    status: string;
    aspects: string[];
    description: Record<string, unknown> | null;
  } | null;
};
export const boardKey = (projectId: string) => ["project", projectId, "board"] as const;
export const useBoard = (projectId: string) =>
  useQuery({
    queryKey: boardKey(projectId),
    queryFn: () => get<{ items: BoardItem[] }>(`/projects/${projectId}/board`),
    select: (r) => r.items,
    // A description being written is polled until it lands.
    refetchInterval: (q) =>
      q.state.data?.items.some((i) => i.described && !["completed", "failed", "cancelled"].includes(i.described.status))
        ? 4000
        : false,
  });

/**
 * The reference board: images collected for mood and look. Each can become a draft reference of a character, an
 * outfit, a location (or one of its states), a prop or the style, or be described for one aspect.
 */
export function BoardPage() {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const q = useBoard(projectId);
  const [uploading, setUploading] = useState(false);
  const upload = async (files: FileList) => {
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const form = new FormData();
        form.set("file", f);
        await api(`/projects/${projectId}/board`, { method: "POST", body: form });
      }
      await qc.invalidateQueries({ queryKey: boardKey(projectId) });
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Reference board"
        subtitle="Images for mood and look. Drop one onto a character, outfit, place, prop or the style as a reference to approve, use it as a panel's layout guide from the page editor, or have one aspect of it described."
        actions={
          <label className={`btn-primary cursor-pointer ${uploading ? "pointer-events-none opacity-50" : ""}`}>
            {uploading ? <Spinner /> : <ImagePlus className="size-4" />} Add images
            <input
              type="file"
              multiple
              className="sr-only"
              accept="image/png,image/jpeg,image/webp"
              aria-label="Add images to the board"
              onChange={(e) => {
                if (e.target.files?.length) void upload(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        }
      />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && !q.data.length && (
        <EmptyState title="The board is empty">
          Add images you want the art to borrow from: a mood, a light, a costume.
        </EmptyState>
      )}
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((it) => (
          <BoardCard key={it.id} item={it} projectId={projectId} />
        ))}
      </ul>
    </div>
  );
}

/** A described aspect as one line: its summary, or the fields of a structured description joined. */
function aspectText(v: unknown): string {
  if (!v) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(aspectText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.summary === "string" && o.summary) return o.summary;
    return Object.values(o).map(aspectText).filter(Boolean).join("; ");
  }
  return String(v);
}

const TARGETS = [
  ["character", "Character"],
  ["outfit", "Outfit"],
  ["location", "Location"],
  ["prop", "Prop"],
  ["style", "Project style"],
] as const;

function BoardCard({ item, projectId }: { item: BoardItem; projectId: string }) {
  const inv = { invalidate: [boardKey(projectId)] };
  const remove = useAction(() => del(`/board-items/${item.id}`), inv);
  const note = useAction((n: string) => patch(`/board-items/${item.id}`, { note: n }), inv);
  const aiText = useAiBody("text");
  const [aspect, setAspect] = useState<ImageAspectKey>("lighting");
  const describe = useAction(() => post(`/assets/${item.assetId}/describe`, { aspects: [aspect], ...aiText() }), {
    ...inv,
    success: "Description queued",
  });
  const d = item.described;
  const summaries = d?.description
    ? [
        ...d.aspects.map((a) => [a, aspectText(d.description?.[a])] as const),
        ["overview", aspectText(d.description.overview)] as const,
      ].filter(([, s]) => s)
    : [];
  return (
    <li className="card flex flex-col gap-2 p-2" aria-label="Board image">
      <AssetImage
        assetId={item.assetId}
        alt={item.note || "Board image"}
        className="aspect-[4/3] w-full rounded"
        fit="contain"
      />
      <textarea
        className="input min-h-10 text-xs"
        placeholder="Why this image: the light, the coat, the mood…"
        defaultValue={item.note}
        aria-label="Note"
        onBlur={(e) => e.target.value !== item.note && note.mutate(e.target.value)}
      />
      <UseAs item={item} projectId={projectId} />
      <div className="flex items-center gap-1">
        <select
          className="input py-1 text-xs"
          aria-label="Aspect to describe"
          value={aspect}
          onChange={(e) => setAspect(e.target.value as ImageAspectKey)}
        >
          {IMAGE_ASPECTS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          disabled={describe.isPending}
          onClick={() => describe.mutate()}
        >
          Describe
        </button>
        <button
          type="button"
          className="btn-ghost ml-auto p-1 text-red-500"
          aria-label="Remove from board"
          onClick={() => remove.mutate()}
        >
          <Trash2 className="size-4" />
        </button>
      </div>
      {d && !summaries.length && (
        <div className="flex items-center gap-1 text-xs">
          <StatusChip status={d.status} /> <span className="muted">describing {d.aspects.join(", ")}</span>
        </div>
      )}
      {summaries.map(([a, s]) => (
        <p key={a} className="rounded bg-[var(--panel-2)] p-2 text-xs">
          <span className="font-medium">{IMAGE_ASPECTS.find((x) => x.key === a)?.label ?? "Overview"}:</span> {s}
        </p>
      ))}
    </li>
  );
}

/** Drop the image onto a character, outfit, location (or one of its states), prop or the project style. */
function UseAs({ item, projectId }: { item: BoardItem; projectId: string }) {
  const [target, setTarget] = useState<(typeof TARGETS)[number][0]>("character");
  const [subjectId, setSubjectId] = useState("");
  const [extra, setExtra] = useState("");
  const cast = useQuery({
    queryKey: qk.cast(projectId),
    queryFn: () => get<{ characters: CastCard[] }>(`/projects/${projectId}/characters`),
    select: (r) => r.characters,
    enabled: target === "character" || target === "outfit",
  });
  const locations = useQuery({
    queryKey: qk.locations(projectId),
    queryFn: () => get<{ locations: LocationCard[] }>(`/projects/${projectId}/locations`),
    select: (r) => r.locations,
    enabled: target === "location",
  });
  const props = useQuery({
    queryKey: qk.props(projectId),
    queryFn: () => get<{ props: PropCard[] }>(`/projects/${projectId}/props`),
    select: (r) => r.props,
    enabled: target === "prop",
  });
  const outfits = useQuery({
    queryKey: ["character", subjectId, "board-outfits"],
    queryFn: () => get<{ outfits: { id: string; name: string }[] }>(`/characters/${subjectId}`),
    select: (r) => r.outfits,
    enabled: target === "outfit" && Boolean(subjectId),
  });
  const states = useLocationStates(target === "location" ? subjectId : "");
  const style = useQuery({
    queryKey: ["project", projectId, "style"],
    queryFn: () => get<{ currentStyleId: string | null }>(`/projects/${projectId}/style`),
    enabled: target === "style",
  });
  const subjects =
    target === "character" || target === "outfit"
      ? (cast.data ?? []).map((c) => ({ id: c.id, name: c.name, versionId: c.currentVersionId }))
      : target === "location"
        ? (locations.data ?? []).map((l) => ({ id: l.id, name: l.name, versionId: l.currentVersionId }))
        : target === "prop"
          ? (props.data ?? []).map((p) => ({ id: p.id, name: p.name, versionId: p.currentVersionId }))
          : [];
  const chosen = subjects.find((s) => s.id === subjectId);
  const use = useAction(
    () =>
      post(
        `/board-items/${item.id}/use`,
        target === "style"
          ? { target, styleId: style.data?.currentStyleId }
          : target === "outfit"
            ? { target, versionId: chosen?.versionId, outfitId: extra }
            : target === "location"
              ? { target, versionId: chosen?.versionId, ...(extra ? { locationStateId: extra } : {}) }
              : { target, versionId: chosen?.versionId },
      ),
    { success: "Added as a draft reference: approve it on its page" },
  );
  const ready =
    target === "style"
      ? Boolean(style.data?.currentStyleId)
      : Boolean(chosen?.versionId) && (target !== "outfit" || Boolean(extra));
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <select
        className="input w-auto py-1 text-xs"
        aria-label="Use as a reference of"
        value={target}
        onChange={(e) => {
          setTarget(e.target.value as typeof target);
          setSubjectId("");
          setExtra("");
        }}
      >
        {TARGETS.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      {target !== "style" && (
        <select
          className="input min-w-0 flex-1 py-1 text-xs"
          aria-label="Which one"
          value={subjectId}
          onChange={(e) => {
            setSubjectId(e.target.value);
            setExtra("");
          }}
        >
          <option value="">Pick…</option>
          {subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      {target === "outfit" && subjectId && (
        <select
          className="input py-1 text-xs"
          aria-label="Outfit"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        >
          <option value="">Outfit…</option>
          {outfits.data?.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {target === "location" && subjectId && Boolean(states.data?.length) && (
        <select
          className="input py-1 text-xs"
          aria-label="State"
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        >
          <option value="">As designed</option>
          {states.data?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="button"
        className="btn-secondary px-2 py-1 text-xs"
        disabled={!ready || use.isPending}
        onClick={() => use.mutate()}
      >
        Use as reference
      </button>
    </div>
  );
}
