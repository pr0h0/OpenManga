import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, FileArchive, Images, Music, RotateCcw, Search, Star, Trash2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get, post, put } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { AssetRow, AssetVariantRow } from "../../api/types.ts";
import {
  AssetImage,
  ConfirmDialog,
  clsx,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  KeyValue,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  TagInput,
} from "../../components/ui.tsx";
import { JsonBlock } from "../generation/shared.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

const TYPES = [
  "character_reference",
  "location_reference",
  "prop_reference",
  "style_reference",
  "panel_art",
  "panel_mask",
  "cover",
  "export",
  "audio",
];
type Detail = {
  asset: AssetRow;
  variants: AssetVariantRow[];
  lineage: { id: string; generationJobId: string | null; createdAt: string }[];
  children: { id: string; createdAt: string }[];
  source: {
    kind: "generated" | "uploaded" | "derived" | "made";
    job: {
      id: string;
      kind: string;
      provider: string | null;
      model: string | null;
      templateName: string | null;
      templateVersion: number | null;
    } | null;
    uploadedName: string | null;
    tool: string | null;
  };
  usedBy: { kind: string; label: string; panelId: string | null }[];
  marks: { tags: string[]; collections: string[]; favourite: boolean };
};
const SOURCE: Record<Detail["source"]["kind"], string> = {
  generated: "Generated",
  uploaded: "Uploaded",
  derived: "Edited or derived from another file",
  made: "Made by the app",
};

function Thumb({ a, className }: { a: AssetRow; className: string }) {
  if (a.mimeType.startsWith("image/"))
    return <AssetImage assetId={a.id} alt={a.type} className={className} trashed={Boolean(a.deletedAt)} />;
  const Icon = a.mimeType.startsWith("audio/") ? Music : FileArchive;
  return (
    <div className={`flex items-center justify-center bg-[var(--panel-2)] ${className}`}>
      <Icon className="muted size-8" />
    </div>
  );
}

type LibraryAsset = AssetRow & {
  tags: string[];
  collections: string[];
  favourite: boolean;
  model: string | null;
};
type Library = {
  assets: LibraryAsset[];
  storage: { bytes: number; variant_bytes: number };
  facets: { tags: string[]; collections: string[]; models: string[] };
};
type View = "" | "favourite" | "unused" | "duplicates" | "trash";
type Entity = { id: string; name: string };

/**
 * The asset library: every file of the project, searchable by name, tag, character, place or prop and filtered by
 * source, model and date; favourites, collections, unused images and duplicate files; bulk actions; and, per file,
 * where it came from, what uses it and images that look like it.
 */
export function AssetsPage() {
  const projectId = useProjectId();
  const [f, setF] = useState({
    q: "",
    type: "",
    tag: "",
    collection: "",
    source: "",
    model: "",
    from: "",
    to: "",
    entity: "",
  });
  const [view, setView] = useState<View>("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulkValue, setBulkValue] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const [kind, entityId] = f.entity.split(":");
  const params = new URLSearchParams({
    ...Object.fromEntries(Object.entries(f).filter(([k, v]) => v && k !== "entity")),
    ...(kind ? { [`${kind}Id`]: entityId! } : {}),
    trash: view === "trash" ? "1" : "0",
    ...(view === "favourite" ? { favourite: "1" } : view === "unused" || view === "duplicates" ? { view } : {}),
  });
  const q = useQuery({
    queryKey: [...qk.assets(projectId), params.toString()],
    queryFn: () => get<Library>(`/projects/${projectId}/assets?${params}`),
  });
  const entities = useQuery({
    queryKey: ["project", projectId, "asset-entities"],
    queryFn: async () => {
      const [c, l, p] = await Promise.all([
        get<{ characters: Entity[] }>(`/projects/${projectId}/characters`),
        get<{ locations: Entity[] }>(`/projects/${projectId}/locations`),
        get<{ props: Entity[] }>(`/projects/${projectId}/props`),
      ]);
      return { characters: c.characters, locations: l.locations, props: p.props };
    },
  });
  const bulk = useAction(
    (action: string) =>
      post<{ done: number; skipped: { reason: string }[] }>(`/projects/${projectId}/assets/bulk`, {
        ids: [...picked],
        action,
        ...(bulkValue.trim() ? { value: bulkValue.trim() } : {}),
      }),
    {
      invalidate: [qk.assets(projectId)],
      success: (r) =>
        `${r.done} done${r.skipped.length ? `, ${r.skipped.length} skipped: ${r.skipped[0]!.reason}` : ""}`,
      onSuccess: () => setPicked(new Set()),
    },
  );
  const favourite = useAction((a: LibraryAsset) => put(`/assets/${a.id}/marks`, { favourite: !a.favourite }), {
    invalidate: [qk.assets(projectId)],
  });
  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const facets = q.data?.facets;
  return (
    <div className="mx-auto max-w-7xl p-6">
      <PageHeader
        title="Assets"
        subtitle={
          q.data
            ? `${fmt.bytes(q.data.storage.bytes)} canonical files · ${fmt.bytes(q.data.storage.variant_bytes)} derivatives`
            : "Canonical images, audio and exports"
        }
      />
      <div className="mb-3 flex flex-wrap gap-1" role="tablist" aria-label="Views">
        {(
          [
            ["", "All"],
            ["favourite", "Favourites"],
            ["unused", "Unused"],
            ["duplicates", "Duplicates"],
            ["trash", "Trash"],
          ] as [View, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            role="tab"
            aria-selected={view === v}
            className={view === v ? "btn-primary" : "btn-secondary"}
            onClick={() => {
              setView(v);
              setPicked(new Set());
            }}
          >
            {v === "favourite" && <Star className="size-4" />}
            {v === "trash" && <Trash2 className="size-4" />}
            {label}
          </button>
        ))}
      </div>
      <div className="mb-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
        <input
          className="input"
          placeholder="Search name, type or tag"
          aria-label="Search"
          value={f.q}
          onChange={set("q")}
        />
        <select className="input" value={f.type} onChange={set("type")} aria-label="Asset type">
          <option value="">All types</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select className="input" value={f.entity} onChange={set("entity")} aria-label="Character, place or prop">
          <option value="">Anyone, anywhere</option>
          {(
            [
              ["character", "Characters", entities.data?.characters],
              ["location", "Places", entities.data?.locations],
              ["prop", "Props", entities.data?.props],
            ] as const
          ).map(([k, label, list]) =>
            list?.length ? (
              <optgroup key={k} label={label}>
                {list.map((e) => (
                  <option key={e.id} value={`${k}:${e.id}`}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
        </select>
        <select className="input" value={f.source} onChange={set("source")} aria-label="Source">
          <option value="">Any source</option>
          <option value="generated">Generated</option>
          <option value="uploaded">Uploaded</option>
          <option value="derived">Edited or derived</option>
        </select>
        <select className="input" value={f.model} onChange={set("model")} aria-label="Model">
          <option value="">Any model</option>
          {facets?.models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <div className="flex min-w-0 gap-1 sm:col-span-2 lg:col-span-2">
          <input className="input min-w-0 flex-1" type="date" aria-label="From" value={f.from} onChange={set("from")} />
          <input className="input min-w-0 flex-1" type="date" aria-label="To" value={f.to} onChange={set("to")} />
        </div>
        {Boolean(facets?.tags.length) && (
          <select className="input" value={f.tag} onChange={set("tag")} aria-label="Tag">
            <option value="">Any tag</option>
            {facets!.tags.map((t) => (
              <option key={t} value={t}>
                #{t}
              </option>
            ))}
          </select>
        )}
        {Boolean(facets?.collections.length) && (
          <select className="input" value={f.collection} onChange={set("collection")} aria-label="Collection">
            <option value="">Any collection</option>
            {facets!.collections.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </div>
      {picked.size > 0 && (
        <section
          aria-label="Bulk actions"
          className="card sticky top-2 z-10 mb-3 flex flex-wrap items-center gap-2 p-2 text-sm"
        >
          <span className="font-medium">{picked.size} selected</span>
          <input
            className="input w-40 py-1"
            placeholder="Tag or collection"
            aria-label="Tag or collection"
            value={bulkValue}
            onChange={(e) => setBulkValue(e.target.value)}
          />
          {(
            [
              ["tag", "Tag"],
              ["untag", "Untag"],
              ["collect", "Add to collection"],
              ["uncollect", "Take out of collection"],
            ] as const
          ).map(([a, label]) => (
            <button
              key={a}
              type="button"
              className="btn-secondary py-1"
              disabled={!bulkValue.trim() || bulk.isPending}
              onClick={() => bulk.mutate(a)}
            >
              {label}
            </button>
          ))}
          <button type="button" className="btn-secondary py-1" onClick={() => bulk.mutate("favourite")}>
            <Star className="size-4" /> Favourite
          </button>
          {view === "trash" ? (
            <button type="button" className="btn-secondary py-1" onClick={() => bulk.mutate("restore")}>
              <RotateCcw className="size-4" /> Restore
            </button>
          ) : (
            <button type="button" className="btn-secondary py-1" onClick={() => bulk.mutate("trash")}>
              <Trash2 className="size-4" /> Move to trash
            </button>
          )}
          <button type="button" className="btn-ghost py-1" onClick={() => setPicked(new Set())}>
            Clear
          </button>
        </section>
      )}
      {view === "unused" && (
        <p className="muted mb-2 text-xs">
          Images nothing uses: not a panel's artwork, a reference, on the board, the cover or the thumbnail.
        </p>
      )}
      {view === "duplicates" && <p className="muted mb-2 text-xs">Files stored more than once, side by side.</p>}
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.assets.length ? (
        <EmptyState
          icon={<Images className="size-8" />}
          title={view === "trash" ? "Trash is empty" : "No assets match"}
        />
      ) : (
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Assets">
          {q.data.assets.map((a) => (
            <div
              key={a.id}
              className={clsx(
                "card relative overflow-hidden text-left hover:border-accent-500",
                picked.has(a.id) && "border-accent-500 ring-2 ring-accent-500/40",
              )}
            >
              <input
                type="checkbox"
                className="absolute top-2 left-2 z-[1] size-4"
                aria-label={`Select ${a.type.replace(/_/g, " ")} ${a.id.slice(0, 8)}`}
                checked={picked.has(a.id)}
                onChange={() => toggle(a.id)}
              />
              <button
                type="button"
                className="absolute top-1.5 right-1.5 z-[1] rounded-full bg-[var(--panel)]/80 p-1"
                aria-label={a.favourite ? "Unfavourite" : "Favourite"}
                aria-pressed={a.favourite}
                onClick={() => favourite.mutate(a)}
              >
                <Star className={clsx("size-4", a.favourite && "fill-amber-400 text-amber-400")} />
              </button>
              <button type="button" className="block w-full text-left" onClick={() => setOpenId(a.id)}>
                <Thumb a={a} className="aspect-square w-full" />
                <div className="p-2 text-xs">
                  <div className="flex items-center justify-between gap-1">
                    <span className="truncate font-medium">{a.type.replace(/_/g, " ")}</span>
                    <StatusChip status={a.status} />
                  </div>
                  <div className="muted">
                    {a.width ? `${a.width}×${a.height} · ` : ""}
                    {fmt.bytes(a.byteSize)}
                    {a.durationMs ? ` · ${fmt.ms(a.durationMs)}` : ""}
                  </div>
                  <div className="muted truncate">
                    {fmt.ago(a.createdAt)}
                    {a.model ? ` · ${a.model}` : ""}
                  </div>
                  {(a.tags.length > 0 || a.collections.length > 0) && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      {a.tags.map((t) => (
                        <span key={t} className="chip text-[10px]">
                          #{t}
                        </span>
                      ))}
                      {a.collections.map((t) => (
                        <span key={t} className="chip bg-accent-600/15 text-[10px]">
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </button>
              {a.mimeType.startsWith("audio/") && (
                // biome-ignore lint/a11y/useMediaCaption: narration transcript lives in the Narration page text
                <audio
                  controls
                  preload="none"
                  src={assetUrl(a.id, undefined, undefined, Boolean(a.deletedAt))}
                  className="w-full px-2 pb-2"
                />
              )}
            </div>
          ))}
        </section>
      )}
      {openId && (
        <AssetDetail
          id={openId}
          projectId={projectId}
          onClose={() => setOpenId(null)}
          onOpen={setOpenId}
          listKey={qk.assets(projectId)}
        />
      )}
    </div>
  );
}

function AssetDetail({
  id,
  projectId,
  onClose,
  onOpen,
  listKey,
}: {
  id: string;
  projectId: string;
  onClose: () => void;
  /** Open another asset (an image like this one). */
  onOpen: (id: string) => void;
  listKey: readonly unknown[];
}) {
  const [like, setLike] = useState(false);
  const similar = useQuery({
    queryKey: ["asset", id, "similar"],
    queryFn: () => get<{ similar: (AssetRow & { score: number })[] }>(`/assets/${id}/similar`),
    enabled: like,
  });
  const q = useQuery({ queryKey: ["asset", id], queryFn: () => get<Detail>(`/assets/${id}`) });
  const [confirm, setConfirm] = useState(false);
  const inv = [listKey, ["asset", id]] as const;
  const trash = useAction(() => post(`/assets/${id}/trash`), { invalidate: inv, success: "Moved to trash" });
  const restore = useAction(() => post(`/assets/${id}/restore`), { invalidate: inv, success: "Restored" });
  const remove = useAction(() => del(`/assets/${id}`), {
    invalidate: [listKey],
    success: "Deleted permanently",
    onSuccess: onClose,
  });
  const saveMarks = useAction((m: Partial<Detail["marks"]>) => put(`/assets/${id}/marks`, m), {
    invalidate: [listKey, ["asset", id]],
  });
  const a = q.data?.asset;
  return (
    <Modal open onClose={onClose} title="Asset" wide>
      {q.error && <ErrorBox error={q.error} />}
      {!a || !q.data ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            {a.mimeType.startsWith("image/") ? (
              <AssetImage
                assetId={a.id}
                variant={null}
                alt={a.type}
                className="max-h-96 w-full rounded-lg"
                fit="contain"
                trashed={Boolean(a.deletedAt)}
              />
            ) : a.mimeType.startsWith("audio/") ? (
              // biome-ignore lint/a11y/useMediaCaption: narration transcript lives in the Narration page text
              <audio controls src={assetUrl(a.id, undefined, undefined, Boolean(a.deletedAt))} className="w-full" />
            ) : (
              <Thumb a={a} className="h-40 w-full rounded-lg" />
            )}
            <div className="space-y-3">
              <KeyValue
                items={[
                  ["Type", a.type],
                  [
                    "Status",
                    <StatusChip
                      key="s"
                      status={a.deletedAt ? "cancelled" : a.status}
                      label={a.deletedAt ? "trashed" : a.status}
                    />,
                  ],
                  ["MIME", a.mimeType],
                  ["Size", `${a.width ? `${a.width}×${a.height} · ` : ""}${fmt.bytes(a.byteSize)}`],
                  [
                    "SHA-256",
                    <code key="h" className="text-xs break-all">
                      {a.sha256}
                    </code>,
                  ],
                  ["Created", fmt.date(a.createdAt)],
                  [
                    "Generation",
                    a.generationJobId ? (
                      <Link
                        key="g"
                        to="/projects/$projectId/generation/$jobId"
                        params={{ projectId, jobId: a.generationJobId }}
                        className="text-accent-500 hover:underline"
                      >
                        {a.generationJobId.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    ),
                  ],
                ]}
              />
              <div className="flex flex-wrap gap-2">
                <a
                  className="btn-secondary"
                  href={assetUrl(a.id, undefined, undefined, Boolean(a.deletedAt))}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-4" /> Full resolution
                </a>
                {a.deletedAt ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => restore.mutate()}
                      disabled={restore.isPending}
                    >
                      <RotateCcw className="size-4" /> Restore
                    </button>
                    <button type="button" className="btn-danger" onClick={() => setConfirm(true)}>
                      <Trash2 className="size-4" /> Delete permanently
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => trash.mutate()}
                    disabled={trash.isPending}
                  >
                    <Trash2 className="size-4" /> Move to trash
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <section aria-label="Where it came from" className="space-y-1 text-sm">
              <h3 className="font-medium">Where it came from</h3>
              <p>{SOURCE[q.data.source.kind]}</p>
              {q.data.source.job && (
                <p className="muted text-xs">
                  {q.data.source.job.kind.replace(/_/g, " ")}
                  {q.data.source.job.provider ? ` · ${q.data.source.job.provider}` : ""}
                  {q.data.source.job.model ? ` · ${q.data.source.job.model}` : ""}
                  {q.data.source.job.templateName
                    ? ` · ${q.data.source.job.templateName} v${q.data.source.job.templateVersion}`
                    : ""}
                </p>
              )}
              {q.data.source.uploadedName && (
                <p className="muted text-xs">From the file {q.data.source.uploadedName}</p>
              )}
              {q.data.source.tool && <p className="muted text-xs">Made with {q.data.source.tool}</p>}
              <h3 className="pt-2 font-medium">Used by</h3>
              {q.data.usedBy.length ? (
                <ul className="text-xs">
                  {q.data.usedBy.map((u) => (
                    <li key={`${u.kind}-${u.label}`}>
                      {u.kind === "panel" ? "Panel" : u.kind === "reference" ? "Reference of" : ""} {u.label}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted text-xs">Nothing uses it.</p>
              )}
            </section>
            <section aria-label="Filing" className="space-y-2 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={q.data.marks.favourite}
                  onChange={(e) => saveMarks.mutate({ favourite: e.target.checked })}
                />
                Favourite
              </label>
              <Field label="Tags">
                <TagInput
                  value={q.data.marks.tags}
                  onChange={(tags) => saveMarks.mutate({ tags })}
                  placeholder="Add a tag"
                />
              </Field>
              <Field label="Collections">
                <TagInput
                  value={q.data.marks.collections}
                  onChange={(collections) => saveMarks.mutate({ collections })}
                  placeholder="Add to a collection"
                />
              </Field>
            </section>
          </div>
          {a.mimeType.startsWith("image/") && (
            <section aria-label="Images like this" className="space-y-2">
              {!like ? (
                <button type="button" className="btn-secondary" onClick={() => setLike(true)}>
                  <Search className="size-4" /> Find images like this
                </button>
              ) : similar.isLoading ? (
                <Spinner />
              ) : (
                <>
                  <h3 className="text-sm font-medium">Images like this</h3>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                    {similar.data?.similar.map((s) => (
                      <button key={s.id} type="button" className="text-left" onClick={() => onOpen(s.id)}>
                        <AssetImage assetId={s.id} alt={s.type} className="aspect-square w-full rounded" />
                        <span className="muted text-[10px]">{Math.round(s.score * 100)}% alike</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
          {q.data.variants.length > 0 && (
            <div>
              <h3 className="mb-1 text-sm font-medium">Derivatives</h3>
              <table className="w-full text-xs">
                <tbody>
                  {q.data.variants.map((v) => (
                    <tr key={v.id} className="border-b border-[var(--border)] last:border-0">
                      <td className="p-1.5 font-medium">{v.variant}</td>
                      <td className="p-1.5">
                        {v.width}×{v.height}
                      </td>
                      <td className="p-1.5">{fmt.bytes(v.byteSize)}</td>
                      <td className="muted p-1.5 font-mono">{JSON.stringify(v.params)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {(q.data.lineage.length > 0 || q.data.children.length > 0) && (
            <div className="text-sm">
              <h3 className="mb-1 font-medium">Lineage</h3>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                {[...q.data.lineage].reverse().map((l) => (
                  <span key={l.id} className="chip bg-[var(--panel-2)]">
                    {l.id.slice(0, 8)} →
                  </span>
                ))}
                <span className="chip bg-accent-600/20">this</span>
                {q.data.children.map((c) => (
                  <span key={c.id} className="chip bg-[var(--panel-2)]">
                    → {c.id.slice(0, 8)}
                  </span>
                ))}
              </div>
            </div>
          )}
          <div>
            <h3 className="mb-1 text-sm font-medium">Metadata</h3>
            <JsonBlock value={a.metadata} maxHeight="14rem" />
          </div>
        </div>
      )}
      <ConfirmDialog
        open={confirm}
        title="Delete permanently?"
        danger
        confirmLabel="Delete"
        busy={remove.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={() => remove.mutate()}
      >
        The file and all derivatives are removed from storage. This cannot be undone.
      </ConfirmDialog>
    </Modal>
  );
}
