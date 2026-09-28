import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, FileArchive, Images, Music, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { AssetRow, AssetVariantRow } from "../../api/types.ts";
import {
  AssetImage,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  fmt,
  KeyValue,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
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

export function AssetsPage() {
  const projectId = useProjectId();
  const [type, setType] = useState("");
  const [trash, setTrash] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const listKey = [...qk.assets(projectId), type, trash] as const;
  const q = useQuery({
    queryKey: listKey,
    queryFn: () =>
      get<{ assets: AssetRow[]; storage: { bytes: number; variant_bytes: number } }>(
        `/projects/${projectId}/assets?${new URLSearchParams({ ...(type ? { type } : {}), trash: trash ? "1" : "0" })}`,
      ),
  });
  return (
    <div className="mx-auto max-w-7xl p-6">
      <PageHeader
        title="Assets"
        subtitle={
          q.data
            ? `${fmt.bytes(q.data.storage.bytes)} canonical files · ${fmt.bytes(q.data.storage.variant_bytes)} derivatives`
            : "Canonical images, audio and exports"
        }
        actions={
          <>
            <select
              className="input w-auto"
              value={type}
              onChange={(e) => setType(e.target.value)}
              aria-label="Asset type"
            >
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.replace(/_/g, " ")}
                </option>
              ))}
            </select>
            <button type="button" className={trash ? "btn-primary" : "btn-secondary"} onClick={() => setTrash(!trash)}>
              <Trash2 className="size-4" /> Trash
            </button>
          </>
        }
      />
      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? (
        <Spinner />
      ) : !q.data?.assets.length ? (
        <EmptyState icon={<Images className="size-8" />} title={trash ? "Trash is empty" : "No assets yet"} />
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {q.data.assets.map((a) => (
            <button
              key={a.id}
              type="button"
              className="card overflow-hidden text-left hover:border-accent-500"
              onClick={() => setOpenId(a.id)}
            >
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
                <div className="muted">{fmt.ago(a.createdAt)}</div>
                {a.mimeType.startsWith("audio/") && (
                  // biome-ignore lint/a11y/useMediaCaption: narration transcript lives in the Narration page text
                  <audio
                    controls
                    preload="none"
                    src={assetUrl(a.id, undefined, undefined, Boolean(a.deletedAt))}
                    className="mt-1 w-full"
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </div>
            </button>
          ))}
        </div>
      )}
      {openId && (
        <AssetDetail id={openId} projectId={projectId} onClose={() => setOpenId(null)} listKey={qk.assets(projectId)} />
      )}
    </div>
  );
}

function AssetDetail({
  id,
  projectId,
  onClose,
  listKey,
}: {
  id: string;
  projectId: string;
  onClose: () => void;
  listKey: readonly unknown[];
}) {
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
