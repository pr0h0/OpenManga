import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, RotateCcw, Users } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { CastCard } from "../../api/types.ts";
import {
  AssetImage,
  EmptyState,
  ErrorBox,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  TagInput,
} from "../../components/ui.tsx";
import { BulkGenerateButton } from "../pages/BulkGenerate.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

const ROLES = ["protagonist", "antagonist", "supporting", "minor"] as const;

export function CastPage() {
  const projectId = useProjectId();
  const [trash, setTrash] = useState(false);
  const [role, setRole] = useState("");
  const [text, setText] = useState("");
  const [adding, setAdding] = useState(false);
  const key = [...qk.cast(projectId), trash] as const;
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: key,
    queryFn: () => get<{ characters: CastCard[] }>(`/projects/${projectId}/characters${trash ? "?trash=1" : ""}`),
  });
  const restore = useAction((id: string) => post(`/characters/${id}/restore`), {
    invalidate: [qk.cast(projectId)],
    success: "Character restored",
  });
  const q = text.trim().toLowerCase();
  const list = (data?.characters ?? []).filter(
    (c) =>
      (!role || c.role === role) &&
      (!q || c.name.toLowerCase().includes(q) || c.aliases.some((a) => a.alias.toLowerCase().includes(q))),
  );

  return (
    <div className="p-6">
      <PageHeader
        title="Cast"
        subtitle="Canonical characters, their appearance versions and identity references."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setTrash(!trash)}>
              {trash ? "Show active" : "Trash"}
            </button>
            {!trash && (
              <BulkGenerateButton
                projectId={projectId}
                scope={{ references: "character" }}
                label="Generate all character references"
                className="btn-secondary"
                noun={{
                  one: "character reference",
                  many: "character references",
                  missing: "Only characters without this kind of reference",
                }}
                kinds={[
                  { value: "full_body", label: "Full body" },
                  { value: "portrait", label: "Portrait" },
                  { value: "multi_angle", label: "Turnaround" },
                  { value: "expression_sheet", label: "Expression sheet" },
                ]}
              />
            )}
            <button type="button" className="btn-primary" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add character
            </button>
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        <input
          className="input max-w-xs"
          placeholder="Filter by name or alias"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Filter characters"
        />
        <select
          className="input w-auto"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Filter by role"
        >
          <option value="">All roles</option>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </div>
      <ErrorBox error={error} onRetry={() => refetch()} />
      {isLoading && <Spinner className="size-6" />}
      {data && !list.length && (
        <EmptyState icon={<Users className="size-8" />} title={trash ? "Trash is empty" : "No characters yet"}>
          {trash ? null : "Analyze your story to extract the cast automatically, or add characters manually."}
        </EmptyState>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {list.map((c) => (
          <div key={c.id} className="card overflow-hidden">
            <Link
              to="/projects/$projectId/cast/$characterId"
              params={{ projectId, characterId: c.id }}
              className="block"
            >
              <AssetImage
                assetId={c.portraitAssetId}
                alt={`${c.name} portrait`}
                className="aspect-[3/4] w-full"
                trashed={trash}
              />
            </Link>
            <div className="space-y-1 p-3">
              <Link
                to="/projects/$projectId/cast/$characterId"
                params={{ projectId, characterId: c.id }}
                className="block truncate font-medium hover:underline"
              >
                {c.name}
              </Link>
              <div className="muted flex items-center gap-2 text-xs capitalize">
                {c.role}
                {c.currentVersion && (
                  <span>
                    · v{c.currentVersion.versionNumber} {c.currentVersion.status}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1 text-xs">
                <StatusChip status={c.referenceStatus} label={`ref: ${c.referenceStatus}`} />
                {c.staleReferences > 0 && (
                  <span
                    className="chip bg-amber-500/15 text-amber-600"
                    title="Reference made from an older description"
                  >
                    stale ref
                  </span>
                )}
                {c.contentWarnings > 0 && (
                  <span
                    className="chip bg-amber-500/15 text-amber-600"
                    title="Description wording that image moderators often block"
                  >
                    {c.contentWarnings} wording warning{c.contentWarnings === 1 ? "" : "s"}
                  </span>
                )}
                <span className="muted">
                  {c.appearances} panel{c.appearances === 1 ? "" : "s"}
                </span>
              </div>
              {c.aliases.length > 0 && (
                <div className="muted truncate text-xs" title={c.aliases.map((a) => a.alias).join(", ")}>
                  aka {c.aliases.map((a) => a.alias).join(", ")}
                </div>
              )}
              {trash && (
                <button
                  type="button"
                  className="btn-secondary mt-1 w-full text-xs"
                  onClick={() => restore.mutate(c.id)}
                >
                  <RotateCcw className="size-3" /> Restore
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      <AddCharacterModal open={adding} onClose={() => setAdding(false)} projectId={projectId} />
    </div>
  );
}

function AddCharacterModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const empty = {
    name: "",
    role: "supporting",
    aliases: [] as string[],
    genderPresentation: "",
    ageRange: "",
    hair: "",
    eyes: "",
    build: "",
    wardrobe: "",
    summary: "",
  };
  const [f, setF] = useState(empty);
  const create = useAction(
    () =>
      post(`/projects/${projectId}/characters`, {
        name: f.name,
        role: f.role,
        aliases: f.aliases,
        description: {
          genderPresentation: f.genderPresentation,
          ageRange: f.ageRange,
          hair: f.hair,
          eyes: f.eyes,
          build: f.build,
          wardrobe: f.wardrobe,
          summary: f.summary,
        },
      }),
    {
      invalidate: [qk.cast(projectId)],
      success: "Character added",
      onSuccess: () => {
        setF(empty);
        onClose();
      },
    },
  );
  const text = (k: keyof typeof empty, label: string) => (
    <label className="block">
      <span className="label">{label}</span>
      <input className="input" value={f[k] as string} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </label>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add character"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!f.name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending && <Spinner />} Create
          </button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {text("name", "Name")}
        <label className="block">
          <span className="label">Role</span>
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </label>
        {text("genderPresentation", "Gender presentation")}
        {text("ageRange", "Age range")}
        {text("hair", "Hair")}
        {text("eyes", "Eyes")}
        {text("build", "Build")}
        {text("wardrobe", "Default wardrobe")}
        <div className="sm:col-span-2">
          <span className="label">Aliases</span>
          <TagInput
            value={f.aliases}
            onChange={(aliases) => setF({ ...f, aliases })}
            placeholder="the boy, the student…"
          />
        </div>
        <label className="block sm:col-span-2">
          <span className="label">Summary</span>
          <textarea
            className="input min-h-16"
            value={f.summary}
            onChange={(e) => setF({ ...f, summary: e.target.value })}
          />
        </label>
      </div>
    </Modal>
  );
}
