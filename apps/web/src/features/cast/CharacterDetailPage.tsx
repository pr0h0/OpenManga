import type { CharacterBible, ImageDescription } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { AlertTriangle, GitBranch, Info, Plus, Trash2, X } from "lucide-react";
import { useCallback, useState } from "react";
import { ApiError, del, get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { CharacterDetail, CharacterVersionRow, ContentWarning } from "../../api/types.ts";
import {
  ConfirmDialog,
  ErrorBox,
  Modal,
  PageHeader,
  SaveIndicator,
  Spinner,
  StatusChip,
  toast,
  useAutosave,
} from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { DescribeImageButton } from "../vision/DescribeImageButton.tsx";
import { FieldGroup, ListRow, TextRow, VERSION_ACTIONS } from "./fields.tsx";
import { OutfitsEditor } from "./OutfitsEditor.tsx";
import { ReferencePanel } from "./ReferencePanel.tsx";

const ROLES = ["protagonist", "antagonist", "supporting", "minor"];

export function CharacterDetailPage() {
  const projectId = useProjectId();
  const { characterId } = useParams({ strict: false }) as { characterId: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const key = qk.character(characterId);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () => get<CharacterDetail>(`/characters/${characterId}`),
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [alias, setAlias] = useState("");
  const refresh = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.character(characterId) });
    qc.invalidateQueries({ queryKey: qk.cast(projectId) });
  }, [qc, characterId, projectId]);
  const inv = { invalidate: [key, qk.cast(projectId)] };

  const rename = useAction(
    (body: { name?: string; role?: string; currentVersionId?: string }) => patch(`/characters/${characterId}`, body),
    inv,
  );
  const trash = useAction(() => del(`/characters/${characterId}`), {
    ...inv,
    success: "Character moved to trash",
    onSuccess: () => navigate({ to: "/projects/$projectId/cast", params: { projectId } }),
  });
  const setStatus = useAction(
    ({ id, status }: { id: string; status: string }) => post(`/character-versions/${id}/status`, { status }),
    inv,
  );
  const newVersion = useAction(
    (fromVersionId: string) =>
      post<{ version: CharacterVersionRow }>(`/characters/${characterId}/versions`, {
        fromVersionId,
        changeNote: "New appearance version",
      }),
    { ...inv, success: (r) => `Created v${r.version.versionNumber}`, onSuccess: (r) => setSelected(r.version.id) },
  );
  const addAlias = useAction(() => post(`/characters/${characterId}/aliases`, { alias: alias.trim() }), {
    ...inv,
    onSuccess: () => setAlias(""),
  });
  const removeAlias = useAction((id: string) => del(`/character-aliases/${id}`), inv);

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
  const { character: ch, versions } = data;
  const version = versions.find((v) => v.id === (selected ?? ch.currentVersionId)) ?? versions[0];

  return (
    <div className="space-y-5 p-6">
      <Link to="/projects/$projectId/cast" params={{ projectId }} className="muted text-xs hover:underline">
        ← Cast
      </Link>
      <PageHeader
        title={
          <input
            className="w-full bg-transparent text-xl font-semibold outline-none focus:underline"
            defaultValue={ch.name}
            key={ch.name}
            aria-label="Character name"
            onBlur={(e) =>
              e.target.value.trim() && e.target.value !== ch.name && rename.mutate({ name: e.target.value.trim() })
            }
          />
        }
        actions={
          <>
            <select
              className="input w-auto"
              value={ch.role}
              onChange={(e) => rename.mutate({ role: e.target.value })}
              aria-label="Role"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setMigrateOpen(true)}
              disabled={versions.length < 2}
            >
              <GitBranch className="size-4" /> Migrate panels
            </button>
            <button
              type="button"
              className="btn-ghost text-red-500"
              onClick={() => setTrashOpen(true)}
              aria-label="Trash character"
            >
              <Trash2 className="size-4" />
            </button>
          </>
        }
      />
      <div className="flex items-start gap-2 rounded-lg border border-accent-500/30 bg-accent-500/10 p-3 text-sm">
        <Info className="mt-0.5 size-4 shrink-0 text-accent-500" />
        <div>
          The approved canonical reference of each version is the identity source of truth. Previous panels are only
          used for continuity, never identity. Changing appearance creates a new version; existing panels keep theirs
          unless you migrate them.
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-[18rem_1fr]">
        <aside className="space-y-4">
          <section className="card p-3">
            <h2 className="mb-2 text-sm font-semibold">Versions</h2>
            <ul className="space-y-1">
              {versions.map((v) => (
                <li key={v.id} className="group relative">
                  <button
                    type="button"
                    onClick={() => setSelected(v.id)}
                    className={`w-full rounded-lg p-2 text-left text-sm ${v.id === version?.id ? "bg-accent-600/15" : "hover:bg-[var(--panel-2)]"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">v{v.versionNumber}</span>
                      <StatusChip status={v.status} />
                      {v.id === ch.currentVersionId && (
                        <span className="chip bg-accent-500/15 text-accent-500">current</span>
                      )}
                    </div>
                    <div className="muted mt-0.5 text-xs">
                      {v.panelCount} panel{v.panelCount === 1 ? "" : "s"} · {v.changeNote || "—"}
                    </div>
                  </button>
                  {v.status === "draft" && versions.length > 1 && v.panelCount === 0 && (
                    <button
                      type="button"
                      aria-label={`Delete draft v${v.versionNumber}`}
                      title="Delete this draft version"
                      className="btn-ghost absolute top-1 right-1 p-1 text-red-500 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                      onClick={async (e) => {
                        e.stopPropagation();
                        if (!window.confirm(`Delete draft v${v.versionNumber}?`)) return;
                        try {
                          await del(`/character-versions/${v.id}`);
                          if (selected === v.id) setSelected(null);
                          await refresh();
                          toast.success(`Deleted v${v.versionNumber}`);
                        } catch (err) {
                          toast.error(err);
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="card p-3">
            <h2 className="mb-2 text-sm font-semibold">Aliases</h2>
            <div className="mb-2 flex flex-wrap gap-1">
              {data.aliases.map((a) => (
                <span key={a.id} className="chip bg-[var(--panel-2)]">
                  {a.alias}
                  <button type="button" onClick={() => removeAlias.mutate(a.id)} aria-label={`Remove alias ${a.alias}`}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {!data.aliases.length && <span className="muted text-xs">None</span>}
            </div>
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (alias.trim()) addAlias.mutate();
              }}
            >
              <input
                className="input"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="the boy"
                aria-label="New alias"
              />
              <button type="submit" className="btn-secondary" aria-label="Add alias">
                <Plus className="size-4" />
              </button>
            </form>
          </section>
          <OutfitsEditor
            references={data.references}
            characterId={characterId}
            versionId={version?.id ?? null}
            outfits={data.outfits}
            onChanged={refresh}
          />
        </aside>

        {version && (
          <div className="min-w-0 space-y-5">
            <section className="card p-4">
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <h2 className="mr-auto font-semibold">Appearance v{version.versionNumber}</h2>
                {version.id !== ch.currentVersionId && (
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={() => rename.mutate({ currentVersionId: version.id })}
                  >
                    Make current
                  </button>
                )}
                {VERSION_ACTIONS[version.status]?.map((a) => (
                  <button
                    key={a.status}
                    type="button"
                    className={a.status === "approved" ? "btn-primary" : "btn-secondary"}
                    disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: version.id, status: a.status })}
                  >
                    {a.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => newVersion.mutate(version.id)}
                  disabled={newVersion.isPending}
                >
                  <GitBranch className="size-4" /> New appearance version
                </button>
              </div>
              {version.status !== "draft" && (
                <p className="muted mb-3 text-sm">
                  This version is <b>{version.status}</b> and read-only so historical panels stay reproducible. Create a
                  new appearance version to change it.
                </p>
              )}
              <ContentWarnings warnings={version.contentWarnings} />
              <BibleEditor key={version.id} version={version} onSaved={refresh} />
            </section>
            <ReferencePanel
              subject="character"
              versionPath="character-versions"
              versionId={version.id}
              versionStatus={version.status}
              references={data.references}
              outfits={data.outfits}
              onChanged={refresh}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={trashOpen}
        title={`Trash ${ch.name}?`}
        danger
        confirmLabel="Move to trash"
        busy={trash.isPending}
        onClose={() => setTrashOpen(false)}
        onConfirm={() => trash.mutate()}
      >
        The character can be restored from the cast trash. Panels keep their references.
      </ConfirmDialog>
      <MigrateModal
        open={migrateOpen}
        onClose={() => setMigrateOpen(false)}
        characterId={characterId}
        versions={versions}
        onDone={refresh}
      />
    </div>
  );
}

function BibleEditor({ version, onSaved }: { version: CharacterVersionRow; onSaved: () => void }) {
  const projectId = useProjectId();
  const [bible, setBible] = useState<CharacterBible>(version.description);
  const editable = version.status === "draft";
  const { state } = useAutosave(
    bible,
    async (b) => {
      await patch(`/character-versions/${version.id}`, { description: b, immutableTraits: b.immutableTraits });
      onSaved();
    },
    { enabled: editable },
  );
  const p = { value: bible, onChange: setBible, disabled: !editable };
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {editable && (
          <DescribeImageButton
            projectId={projectId}
            aspect="character"
            label="Fill from image"
            title="Describe a character from a reference image"
            className="btn-secondary px-2 py-1 text-xs"
            onUse={(d: ImageDescription) => {
              // Merge rather than replace: only fields the image actually described are written, so existing
              // notes the model could not see survive.
              const from = (d.character ?? {}) as Partial<CharacterBible>;
              const filled = Object.fromEntries(
                Object.entries(from).filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? "").trim())),
              );
              setBible((b) => ({ ...b, ...filled }) as CharacterBible);
              toast.info(`Filled ${Object.keys(filled).length} field(s) from the image — review, then it autosaves`);
            }}
          />
        )}
        <SaveIndicator state={state} />
      </div>
      <TextRow {...p} k="summary" label="Summary" multiline />
      <FieldGroup title="Identity">
        <TextRow {...p} k="genderPresentation" label="Gender presentation" />
        <TextRow {...p} k="ageRange" label="Age / age range" />
        <TextRow {...p} k="height" label="Height" />
        <TextRow {...p} k="build" label="Body build" />
      </FieldGroup>
      <FieldGroup title="Face">
        <TextRow {...p} k="faceShape" label="Face shape" />
        <TextRow {...p} k="skinTone" label="Skin tone" />
        <TextRow {...p} k="eyes" label="Eyes" />
        <TextRow {...p} k="eyebrows" label="Eyebrows" />
        <TextRow {...p} k="nose" label="Nose" />
        <TextRow {...p} k="mouth" label="Mouth" />
        <ListRow {...p} k="distinctiveFeatures" label="Distinctive features" />
      </FieldGroup>
      <FieldGroup title="Hair">
        <TextRow {...p} k="hair" label="Hair" />
        <TextRow {...p} k="facialHair" label="Facial hair" />
      </FieldGroup>
      <FieldGroup title="Wardrobe & equipment">
        <TextRow {...p} k="wardrobe" label="Default wardrobe" multiline />
        <ListRow {...p} k="accessories" label="Accessories" />
        <ListRow {...p} k="weapons" label="Weapons" />
        <ListRow {...p} k="props" label="Props" />
      </FieldGroup>
      <FieldGroup title="Personality">
        <TextRow {...p} k="personality" label="Personality" />
        <TextRow {...p} k="visualMannerisms" label="Visual mannerisms" />
        <TextRow {...p} k="defaultExpression" label="Default expression" />
      </FieldGroup>
      <FieldGroup title="Consistency">
        <div className="sm:col-span-2">
          <ListRow {...p} k="immutableTraits" label="Immutable visual traits (never change)" />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <span className="label">Outfit variants (described)</span>
          {bible.outfitVariants.map((o, i) => (
            <div key={i} className="flex gap-2">
              <input
                className="input w-40"
                value={o.name}
                disabled={!editable}
                aria-label="Variant name"
                onChange={(e) =>
                  setBible({
                    ...bible,
                    outfitVariants: bible.outfitVariants.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                  })
                }
              />
              <input
                className="input"
                value={o.description}
                disabled={!editable}
                aria-label="Variant description"
                onChange={(e) =>
                  setBible({
                    ...bible,
                    outfitVariants: bible.outfitVariants.map((x, j) =>
                      j === i ? { ...x, description: e.target.value } : x,
                    ),
                  })
                }
              />
              {editable && (
                <button
                  type="button"
                  className="btn-ghost"
                  aria-label="Remove variant"
                  onClick={() => setBible({ ...bible, outfitVariants: bible.outfitVariants.filter((_, j) => j !== i) })}
                >
                  <X className="size-4" />
                </button>
              )}
            </div>
          ))}
          {editable && (
            <button
              type="button"
              className="btn-ghost text-xs"
              onClick={() =>
                setBible({ ...bible, outfitVariants: [...bible.outfitVariants, { name: "Variant", description: "" }] })
              }
            >
              <Plus className="size-3" /> Add variant
            </button>
          )}
        </div>
      </FieldGroup>
    </div>
  );
}

/** Wording in prompt-visible fields that image moderators often block; suggestions only, nothing is changed. */
function ContentWarnings({ warnings }: { warnings: ContentWarning[] }) {
  if (!warnings.length) return null;
  return (
    <div className="mb-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
      <div className="mb-1 flex items-center gap-2 font-medium text-amber-700 dark:text-amber-400">
        <AlertTriangle className="size-4" /> Wording that image moderators often block
      </div>
      <p className="muted mb-2 text-xs">
        These fields are sent with every panel this character appears in. Read together, body and injury words look like
        malnutrition or harm to a moderator even in harmless scenes. If you change them, regenerate the reference too:
        the old image still shows the old description.
      </p>
      <ul className="space-y-1 text-xs">
        {warnings.map((w, i) => (
          <li key={`${w.field}-${w.match}-${i}`}>
            <b>{w.field}</b>: “{w.match}” → try “{w.suggestion}”<span className="muted"> · {w.excerpt}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MigrateModal({
  open,
  onClose,
  characterId,
  versions,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  characterId: string;
  versions: CharacterDetail["versions"];
  onDone: () => void;
}) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [blocked, setBlocked] = useState<string | null>(null);
  const migrate = useAction(
    async (force: boolean) => {
      try {
        return await post<{ migrated: number }>(`/characters/${characterId}/migrate-panels`, {
          fromVersionId: from,
          toVersionId: to,
          force,
        });
      } catch (e) {
        if (e instanceof ApiError && e.code === "no_approved_reference") {
          setBlocked(e.message);
          return null;
        }
        throw e;
      }
    },
    {
      success: (r) => (r ? `Migrated ${r.migrated} panel(s)` : ""),
      onSuccess: (r) => {
        if (!r) return;
        setBlocked(null);
        onDone();
        onClose();
      },
    },
  );
  const opt = versions.map((v) => (
    <option key={v.id} value={v.id}>
      v{v.versionNumber} ({v.status}, {v.panelCount} panels)
    </option>
  ));
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Migrate panels to another version"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!from || !to || from === to || migrate.isPending}
            onClick={() => migrate.mutate(Boolean(blocked))}
          >
            {blocked ? "Migrate anyway" : "Migrate"}
          </button>
        </>
      }
    >
      {blocked && <p className="mb-3 rounded-lg bg-amber-500/10 p-2 text-sm text-amber-700">{blocked}</p>}
      <p className="muted mb-3 text-sm">
        Panels referencing the source version will use the target version's appearance and references on their next
        generation. Existing artwork is not changed.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label>
          <span className="label">From</span>
          <select className="input" value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Select…</option>
            {opt}
          </select>
        </label>
        <label>
          <span className="label">To</span>
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Select…</option>
            {opt}
          </select>
        </label>
      </div>
    </Modal>
  );
}
