import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { GitBranch, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { LocationRow, LocationVersionRow, PropRow, PropVersionRow, Reference } from "../../api/types.ts";
import {
  ConfirmDialog,
  ErrorBox,
  PageHeader,
  SaveIndicator,
  Spinner,
  StatusChip,
  useAutosave,
} from "../../components/ui.tsx";
import { FieldGroup, ListRow, TextRow, VERSION_ACTIONS } from "../cast/fields.tsx";
import { ReferencePanel } from "../cast/ReferencePanel.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

type Kind = "location" | "prop";
type Version = LocationVersionRow | PropVersionRow;

export const LocationDetailPage = () => <EntityDetail kind="location" />;
export const PropDetailPage = () => <EntityDetail kind="prop" />;

function EntityDetail({ kind }: { kind: Kind }) {
  const projectId = useProjectId();
  const { entityId } = useParams({ strict: false }) as { entityId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const plural = kind === "location" ? "locations" : "props";
  const versionPath = kind === "location" ? "location-versions" : "prop-versions";
  const key = kind === "location" ? qk.location(entityId) : qk.prop(entityId);
  const listKey = kind === "location" ? qk.locations(projectId) : qk.props(projectId);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () =>
      get<Record<string, unknown> & { versions: Version[]; references: Reference[] }>(`/${plural}/${entityId}`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: kind === "location" ? qk.location(entityId) : qk.prop(entityId) });
    qc.invalidateQueries({ queryKey: kind === "location" ? qk.locations(projectId) : qk.props(projectId) });
  }, [qc, kind, entityId, projectId]);
  const inv = { invalidate: [key, listKey] };
  const update = useAction(
    (body: { name?: string; currentVersionId?: string }) => patch(`/${plural}/${entityId}`, body),
    inv,
  );
  const setStatus = useAction(
    ({ id, status }: { id: string; status: string }) => post(`/${versionPath}/${id}/status`, { status }),
    inv,
  );
  const newVersion = useAction(
    (fromVersionId: string) => post<{ version: Version }>(`/${plural}/${entityId}/versions`, { fromVersionId }),
    { ...inv, success: (r) => `Created v${r.version.versionNumber}`, onSuccess: (r) => setSelected(r.version.id) },
  );
  const restore = useAction(() => post(`/${plural}/${entityId}/restore`), {
    invalidate: [key, listKey],
    success: "Restored",
  });
  const trash = useAction(() => del(`/${plural}/${entityId}`), {
    invalidate: [listKey],
    success: "Moved to trash",
    onSuccess: () => navigate({ to: "/projects/$projectId/world", params: { projectId } }),
  });

  if (isLoading)
    return (
      <div className="p-6">
        <Spinner className="size-6" />
      </div>
    );
  if (error || !data)
    return (
      <div className="p-6">
        <ErrorBox error={error} onRetry={() => refetch()} />
      </div>
    );
  const entity = data[kind] as LocationRow | PropRow;
  const version = data.versions.find((v) => v.id === (selected ?? entity.currentVersionId)) ?? data.versions[0];

  return (
    <div className="space-y-5 p-6">
      <Link to="/projects/$projectId/world" params={{ projectId }} className="muted text-xs hover:underline">
        ← World
      </Link>
      {entity.deletedAt && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-amber-500/10 p-3 text-sm">
          <span className="mr-auto">
            {`This ${kind}`} is in the trash, with its reference images. Restoring it brings them back.
          </span>
          <button type="button" className="btn-secondary" disabled={restore.isPending} onClick={() => restore.mutate()}>
            <RotateCcw className="size-4" /> Restore
          </button>
        </div>
      )}
      <PageHeader
        title={
          <input
            key={entity.name}
            className="w-full bg-transparent text-xl font-semibold outline-none focus:underline"
            defaultValue={entity.name}
            aria-label="Name"
            onBlur={(e) =>
              e.target.value.trim() && e.target.value !== entity.name && update.mutate({ name: e.target.value.trim() })
            }
          />
        }
        subtitle={kind === "location" ? "Recurring location" : "Recurring prop"}
        actions={
          <button
            type="button"
            className="btn-ghost text-red-500"
            onClick={() => setTrashOpen(true)}
            aria-label="Trash"
          >
            <Trash2 className="size-4" />
          </button>
        }
      />
      <div className="grid gap-5 xl:grid-cols-[16rem_1fr]">
        <section className="card h-fit p-3">
          <h2 className="mb-2 text-sm font-semibold">Versions</h2>
          {data.versions.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => setSelected(v.id)}
              className={`mb-1 flex w-full items-center gap-2 rounded-lg p-2 text-sm ${v.id === version?.id ? "bg-accent-600/15" : "hover:bg-[var(--panel-2)]"}`}
            >
              <span className="font-medium">v{v.versionNumber}</span>
              <StatusChip status={v.status} />
              {v.id === entity.currentVersionId && (
                <span className="chip bg-accent-500/15 text-accent-500">current</span>
              )}
            </button>
          ))}
        </section>
        {version && (
          <div className="min-w-0 space-y-5">
            <section className="card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto font-semibold">Description v{version.versionNumber}</h2>
                {version.id !== entity.currentVersionId && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => update.mutate({ currentVersionId: version.id })}
                  >
                    Make current
                  </button>
                )}
                {VERSION_ACTIONS[version.status]?.map((a) => (
                  <button
                    key={a.status}
                    type="button"
                    className={a.status === "approved" ? "btn-primary" : "btn-secondary"}
                    onClick={() => setStatus.mutate({ id: version.id, status: a.status })}
                  >
                    {a.label}
                  </button>
                ))}
                <button type="button" className="btn-secondary" onClick={() => newVersion.mutate(version.id)}>
                  <GitBranch className="size-4" /> New version
                </button>
              </div>
              {version.status !== "draft" && (
                <p className="muted mb-3 text-sm">
                  This version is {version.status} and read-only. Create a new version to change it.
                </p>
              )}
              <DescriptionEditor
                key={version.id}
                kind={kind}
                version={version}
                versionPath={versionPath}
                onSaved={refresh}
              />
            </section>
            <ReferencePanel
              subject={kind}
              versionPath={versionPath}
              versionId={version.id}
              versionStatus={version.status}
              references={data.references}
              onChanged={refresh}
              trashed={Boolean(entity.deletedAt)}
            />
          </div>
        )}
      </div>
      <ConfirmDialog
        open={trashOpen}
        title={`Trash ${entity.name}?`}
        danger
        confirmLabel="Move to trash"
        busy={trash.isPending}
        onClose={() => setTrashOpen(false)}
        onConfirm={() => trash.mutate()}
      >
        It can be restored from the World trash.
      </ConfirmDialog>
    </div>
  );
}

function DescriptionEditor({
  kind,
  version,
  versionPath,
  onSaved,
}: {
  kind: Kind;
  version: Version;
  versionPath: string;
  onSaved: () => void;
}) {
  const [desc, setDesc] = useState<Record<string, unknown>>(version.description as Record<string, unknown>);
  const editable = version.status === "draft";
  const { state } = useAutosave(
    desc,
    async (d) => {
      await patch(`/${versionPath}/${version.id}`, { description: d });
      onSaved();
    },
    { enabled: editable },
  );
  const p = { value: desc, onChange: setDesc, disabled: !editable };
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <SaveIndicator state={state} />
      </div>
      <TextRow {...p} k="summary" label="Summary" multiline />
      {kind === "location" ? (
        <FieldGroup title="Environment">
          <TextRow {...p} k="kind" label="Type (room, street, vehicle interior…)" />
          <TextRow {...p} k="architecture" label="Architecture" />
          <TextRow {...p} k="layout" label="Layout" />
          <TextRow {...p} k="palette" label="Palette" />
          <TextRow {...p} k="lighting" label="Lighting" />
          <TextRow {...p} k="atmosphere" label="Atmosphere" />
        </FieldGroup>
      ) : (
        <FieldGroup title="Object">
          <TextRow {...p} k="kind" label="Type" />
          <TextRow {...p} k="material" label="Material" />
          <TextRow {...p} k="size" label="Size" />
          <TextRow {...p} k="colors" label="Colors" />
        </FieldGroup>
      )}
      <FieldGroup title="Consistency">
        <ListRow {...p} k="keyFeatures" label="Key features" />
        <ListRow {...p} k="immutableTraits" label="Immutable traits" />
      </FieldGroup>
    </div>
  );
}
