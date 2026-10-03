import type { ChannelProfile, ProjectSettings } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get, patch, post } from "../../api/client.ts";
import { useAction, useMe } from "../../api/hooks.ts";
import type { TtsStatus } from "../../api/types.ts";
import { ConfirmDialog, EmptyState, Field, PageHeader, Spinner } from "../../components/ui.tsx";
import { PronunciationSection } from "../project/PronunciationSection.tsx";
import { LetteringSection } from "../project/SettingsPage.tsx";
import { PublishingSection, VideoSection } from "../project/VideoSettings.tsx";
import { useProfiles } from "./ApplyProfile.tsx";

type Settings = ChannelProfile["settings"];
type Draft = { id: string | null; name: string; description: string; preset: string | null; settings: Settings };
type Presets = { presets: { key: string; name: string }[]; templates: { id: string; name: string }[] };
type Runtime = NonNullable<ProjectSettings["targetRuntime"]>;

const usePresets = () =>
  useQuery({ queryKey: ["production-presets"], queryFn: () => get<Presets>("/production-presets") });

/**
 * Channel profiles: the account's publication identities. A profile is who publishes (voice, branding, thumbnail
 * and YouTube rules, export shape); a preset or template is what kind of project it is. A profile names one to
 * start from, and every project made from it copies both.
 */
export function ChannelProfilesPage() {
  const profiles = useProfiles();
  const presets = usePresets();
  const { data: me } = useMe();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ChannelProfile | null>(null);
  const remove = useAction((id: string) => del(`/channel-profiles/${id}`), {
    invalidate: [["channel-profiles"]],
    success: "Profile deleted",
  });
  const presetName = (key: string | null) =>
    !key
      ? "no preset"
      : key.startsWith("template:")
        ? `template ${presets.data?.templates.find((t) => `template:${t.id}` === key)?.name ?? "(deleted)"}`
        : (presets.data?.presets.find((p) => p.key === key)?.name ?? key);
  if (draft) return <ProfileEditor draft={draft} presets={presets.data} onDone={() => setDraft(null)} />;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <PageHeader
        title="Channel profiles"
        subtitle="Your channel's identity, applied to new projects: narrator, branding, thumbnail and YouTube rules, export shape."
        actions={
          <button
            type="button"
            className="btn-primary"
            onClick={() =>
              setDraft({
                id: null,
                name: "",
                description: "",
                preset: null,
                settings: me?.settings?.narrationVoice ? { narrationVoice: me.settings.narrationVoice } : {},
              })
            }
          >
            <Plus className="size-4" /> New profile
          </button>
        }
      />
      <p className="muted text-sm">
        A <strong>template</strong> or preset sets up a kind of project: type, format, style. A <strong>profile</strong>{" "}
        is who publishes it, and can name a preset or template to start from. Choosing a profile in the new-project
        wizard copies both in; a project keeps its own copy, and <em>Re-apply profile</em> on its overview brings later
        profile changes over. You can also save a profile from a project's settings.
      </p>
      {profiles.isLoading && <Spinner />}
      {profiles.data && !profiles.data.profiles.length && (
        <EmptyState title="No profiles yet">Create one, or save one from a project's settings.</EmptyState>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {profiles.data?.profiles.map((p) => {
          const logo = p.settings.video?.watermark?.assetId;
          return (
            <li key={p.id} className="card flex gap-3 p-4">
              {logo && (
                <img
                  src={assetUrl(logo)}
                  alt=""
                  className="size-12 shrink-0 rounded border border-[var(--border)] bg-[var(--panel-2)] object-contain p-1"
                />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{p.name}</div>
                {p.description && <div className="muted line-clamp-2 text-xs">{p.description}</div>}
                <div className="muted mt-1 text-xs">
                  Starts from {presetName(p.preset)} · {Object.keys(p.settings).length} settings
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() =>
                      setDraft({
                        id: p.id,
                        name: p.name,
                        description: p.description,
                        preset: p.preset,
                        settings: p.settings,
                      })
                    }
                  >
                    Edit
                  </button>
                  <Link to="/projects/new" search={{ profile: p.id }} className="btn-secondary text-xs">
                    New project
                  </Link>
                  <button type="button" className="btn-ghost text-xs text-red-500" onClick={() => setDeleting(p)}>
                    Delete
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <ConfirmDialog
        open={Boolean(deleting)}
        danger
        title={`Delete profile "${deleting?.name}"?`}
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id);
          setDeleting(null);
        }}
      >
        Projects made from it keep their settings and their copy of its logo.
      </ConfirmDialog>
    </div>
  );
}

const KEEP = "Keep the project's";

function ProfileEditor({ draft, presets, onDone }: { draft: Draft; presets?: Presets; onDone: () => void }) {
  const [d, setD] = useState(draft);
  const tts = useQuery({ queryKey: ["tts-status"], queryFn: () => get<TtsStatus>("/tts/status"), staleTime: 60_000 });
  const s = d.settings;
  /** Sets a profile setting; undefined leaves it out, so a project keeps its own. */
  const setS = (patch: Partial<Settings>) => {
    const next: Record<string, unknown> = { ...s, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    setD({ ...d, settings: next as Settings });
  };
  const save = useAction(
    () => {
      const body = { name: d.name.trim(), description: d.description, preset: d.preset, settings: s };
      return d.id ? patch(`/channel-profiles/${d.id}`, body) : post("/channel-profiles", body);
    },
    { invalidate: [["channel-profiles"]], success: "Profile saved", onSuccess: onDone },
  );
  const select = <K extends "imageQuality" | "referencePolicy" | "batchPolicy">(
    k: K,
    options: [NonNullable<Settings[K]>, string][],
  ) => (
    <select
      className="input"
      value={s[k] ?? ""}
      onChange={(e) => setS({ [k]: (e.target.value || undefined) as Settings[K] })}
    >
      <option value="">{KEEP}</option>
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
  const rt = s.targetRuntime;
  const setRt = (p: Partial<Runtime>) => rt && setS({ targetRuntime: { ...rt, ...p } });
  const rtNum = (k: keyof Runtime, min: number, max: number, step = 1) => (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      step={step}
      value={rt?.[k] ?? ""}
      onChange={(e) => e.target.value !== "" && setRt({ [k]: Number(e.target.value) })}
    />
  );
  const voices = tts.data?.voices ?? [];
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <PageHeader
        title={d.id ? `Edit ${draft.name}` : "New channel profile"}
        subtitle="Settings left on “keep” stay as the preset or project has them."
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={onDone}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!d.name.trim() || save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending && <Spinner />} Save profile
            </button>
          </>
        }
      />
      <section className="card grid gap-3 p-4 sm:grid-cols-2">
        <Field label="Name">
          <input
            className="input"
            maxLength={80}
            value={d.name}
            onChange={(e) => setD({ ...d, name: e.target.value })}
            autoFocus
          />
        </Field>
        <Field label="Starts from" hint="The preset or template new projects are set up with: type, format, style.">
          <select
            className="input"
            value={d.preset ?? ""}
            onChange={(e) => setD({ ...d, preset: e.target.value || null })}
          >
            <option value="">No preset (choose in the wizard)</option>
            {presets?.presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
            {presets?.templates.map((t) => (
              <option key={t.id} value={`template:${t.id}`}>
                Template: {t.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description">
            <textarea
              className="input min-h-14"
              maxLength={500}
              value={d.description}
              onChange={(e) => setD({ ...d, description: e.target.value })}
            />
          </Field>
        </div>
      </section>

      <section className="card grid gap-3 p-4 sm:grid-cols-3">
        <h2 className="font-medium sm:col-span-3">Production</h2>
        <Field label="Image quality">
          {select("imageQuality", [
            ["low", "Low"],
            ["medium", "Medium"],
            ["high", "High"],
          ])}
        </Field>
        <Field label="References to generate">
          {select("referencePolicy", [
            ["all", "All"],
            ["main", "Main cast and recurring places"],
          ])}
        </Field>
        <Field label="Production runs spend">
          {select("batchPolicy", [
            ["interactive", "Everything now"],
            ["images", "Images in batches"],
            ["hybrid", "Text in batches"],
            ["cheapest", "Everything in batches"],
          ])}
        </Field>
        <Field label="Target runtime">
          <select
            className="input"
            value={rt === undefined ? "" : rt === null ? "none" : "set"}
            onChange={(e) =>
              setS({
                targetRuntime:
                  e.target.value === "set"
                    ? { minutes: 30, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 8 }
                    : e.target.value === "none"
                      ? null
                      : undefined,
              })
            }
          >
            <option value="">{KEEP}</option>
            <option value="none">No target</option>
            <option value="set">Aim for a length</option>
          </select>
        </Field>
        {rt && (
          <div className="grid grid-cols-2 gap-3 sm:col-span-2 sm:grid-cols-4">
            <Field label="Minutes">{rtNum("minutes", 1, 600)}</Field>
            <Field label="Words/min">{rtNum("wordsPerMinute", 80, 260)}</Field>
            <Field label="Shortest shot (s)">{rtNum("minShotSeconds", 1, 30, 0.5)}</Field>
            <Field label="Longest shot (s)">{rtNum("maxShotSeconds", 2, 60, 0.5)}</Field>
          </div>
        )}
      </section>

      <section className="card grid gap-3 p-4 sm:grid-cols-2">
        <h2 className="font-medium sm:col-span-2">Narrator</h2>
        <Field label="Voice">
          <select
            className="input"
            value={s.narrationVoice ?? ""}
            onChange={(e) => setS({ narrationVoice: e.target.value || undefined })}
          >
            <option value="">{KEEP}</option>
            {s.narrationVoice && !voices.some((v) => v.id === s.narrationVoice) && (
              <option value={s.narrationVoice}>{s.narrationVoice}</option>
            )}
            {voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name} {v.language && `(${v.language})`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Speed (0.5–2×)" hint="Empty keeps the project's.">
          <input
            className="input"
            type="number"
            min={0.5}
            max={2}
            step={0.05}
            value={s.narrationSpeed ?? ""}
            onChange={(e) =>
              setS({
                narrationSpeed: e.target.value === "" ? undefined : Math.min(2, Math.max(0.5, Number(e.target.value))),
              })
            }
          />
        </Field>
      </section>

      {/* An empty dictionary is left out, so projects keep their own; a filled one replaces theirs when applied. */}
      <PronunciationSection
        value={s.pronunciation ?? []}
        voice={s.narrationVoice ?? "af_heart"}
        speed={s.narrationSpeed ?? 1}
        onChange={(v) => setS({ pronunciation: v.length ? v : undefined })}
      />

      <VideoSection
        logoUpload="/channel-profiles/logo"
        projectTitle={d.name}
        value={s.video}
        onChange={(video) => setS({ video })}
      />
      <PublishingSection value={s} onChange={(v) => setS(v)} />
      <LetteringSection value={s.lettering} onChange={(lettering) => setS({ lettering })} />
    </div>
  );
}
