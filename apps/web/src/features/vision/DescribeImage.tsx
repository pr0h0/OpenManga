import { IMAGE_ASPECTS, type ImageAspectKey, type ImageDescription } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Boxes,
  Check,
  Clapperboard,
  Copy,
  Crop,
  Heart,
  Image as ImageIcon,
  Landmark,
  Loader2,
  Palette,
  Shirt,
  Sparkles,
  Sun,
  Upload,
  User,
  Wand2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { api, get } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import { clsx, ErrorBox, Field, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

const ICONS: Record<string, typeof ImageIcon> = {
  style: Sparkles,
  character: User,
  outfit: Shirt,
  location: Landmark,
  lighting: Sun,
  composition: Crop,
  mood: Heart,
  props: Boxes,
  era: Clapperboard,
  technique: Palette,
};

type JobDetail = { job: { id: string; status: string; failureReason: string | null; result: unknown } };

/** A tick-able card: the aspect's name and what it will actually ask for. */
function AspectCard({
  aspect,
  on,
  toggle,
}: {
  aspect: (typeof IMAGE_ASPECTS)[number];
  on: boolean;
  toggle: () => void;
}) {
  const Icon = ICONS[aspect.key] ?? ImageIcon;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      className={clsx(
        "flex items-start gap-2.5 rounded-lg border p-3 text-left transition-colors",
        on
          ? "border-accent-500 bg-accent-600/10"
          : "border-[var(--border)] bg-[var(--panel-2)] hover:border-[var(--border-strong)]",
      )}
    >
      <span
        className={clsx(
          "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md",
          on ? "bg-accent-600 text-white" : "bg-[var(--panel)] text-[var(--muted)]",
        )}
      >
        {on ? <Check className="size-4" /> : <Icon className="size-4" />}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{aspect.label}</span>
        <span className="muted block text-xs leading-snug">{aspect.hint}</span>
        {aspect.applies && (
          <span className="mt-1 inline-block rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-300">
            can be applied to the project
          </span>
        )}
      </span>
    </button>
  );
}

function ResultCard({ title, value, actions }: { title: string; value: unknown; actions?: ReactNode }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  const pretty =
    value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>)
          .filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? "").trim()))
          .map(([k, v]) => ({ k, v: Array.isArray(v) ? v.join(", ") : String(v) }))
      : null;
  return (
    <section className="card space-y-2 p-3">
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <div className="ml-auto flex items-center gap-1">
          {actions}
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            onClick={async () => {
              await navigator.clipboard.writeText(text).catch(() => {});
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </header>
      {pretty ? (
        <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[10rem_1fr]">
          {pretty.map(({ k, v }) => (
            <div key={k} className="contents">
              <dt className="muted text-xs capitalize sm:text-sm">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</dt>
              <dd className="mb-1 sm:mb-0">{v}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      )}
    </section>
  );
}

/**
 * Upload a reference image — a frame from a video, a page someone else drew — and get back descriptions that can
 * be generated from. The aspects that map onto a project entity can be applied straight into it.
 */
export type DescribeImageHandle = {
  show: (d: ImageDescription, from: { projectTitle: string; assetId: string | null }) => void;
};

export function DescribeImage({
  projectId,
  only,
  onUse,
  handleRef,
}: {
  projectId: string;
  only?: ImageAspectKey[];
  /** Set when the caller has a form to fill: results offer "Use this" instead of creating project entities. */
  onUse?: (description: ImageDescription) => void;
  /** Lets the page display a stored description in the same result view. */
  handleRef?: { current: DescribeImageHandle | null };
}) {
  const offered = only ? IMAGE_ASPECTS.filter((a) => only.includes(a.key)) : IMAGE_ASPECTS;
  const [picked, setPicked] = useState<ImageAspectKey[]>(() => (only ? [...only] : ["style"]));
  const [custom, setCustom] = useState("");
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [description, setDescription] = useState<ImageDescription | null>(null);
  /** Set when the shown description came from history rather than this upload. */
  const [reusedFrom, setReusedFrom] = useState<{ projectTitle: string; assetId: string | null } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const cast = useQuery({
    queryKey: qk.cast(projectId),
    queryFn: () => get<{ characters: { id: string; name: string }[] }>(`/projects/${projectId}/characters`),
    enabled: !onUse,
    staleTime: 60_000,
  });
  const world = useQuery({
    queryKey: qk.locations(projectId),
    queryFn: () => get<{ locations: { id: string; name: string }[] }>(`/projects/${projectId}/locations`),
    enabled: !onUse,
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      show: (d, from) => {
        setDescription(d);
        setReusedFrom(from);
        setError(null);
      },
    };
  }, [handleRef]);

  useEffect(() => {
    if (!file) return setPreviewUrl(null);
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const toggle = (k: ImageAspectKey) => setPicked((p) => (p.includes(k) ? p.filter((x) => x !== k) : [...p, k]));

  const run = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setDescription(null);
    setReusedFrom(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("aspects", JSON.stringify(picked));
      form.set("custom", custom);
      form.set("note", note);
      const ai = aiText();
      if ("ai" in ai && ai.ai) form.set("ai", JSON.stringify(ai.ai));
      const started = await api<{ job: { id: string } }>(`/projects/${projectId}/images/describe`, {
        method: "POST",
        body: form,
      });
      // Vision descriptions come back in seconds, so wait for it here rather than sending the user elsewhere.
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await get<JobDetail>(`/generations/${started.job.id}`);
        if (d.job.status === "completed") {
          setDescription((d.job.result as { description: ImageDescription }).description);
          break;
        }
        if (["failed", "cancelled"].includes(d.job.status))
          throw new Error(d.job.failureReason ?? "The description job did not finish");
        if (Date.now() > deadline) throw new Error("Still running — check the Generation page for the result");
      }
      await qc.invalidateQueries({ queryKey: qk.assets(projectId) }).catch(() => {});
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (kind: "style" | "character" | "location", applyTo?: string) => {
    if (!description) return;
    setApplying(kind);
    try {
      if (kind === "style") {
        await api(`/projects/${projectId}/style`, {
          method: "POST",
          body: {
            stylePresetKey: null,
            customDefinition: description.style,
            customDescription: description.style?.summary ?? description.overview,
          },
        });
        toast.success("Project art style set from the image");
      } else if (kind === "character") {
        const name = window.prompt(
          "Name this character",
          description.character?.summary?.slice(0, 40) || "New character",
        );
        if (!name) return;
        await api(`/projects/${projectId}/characters`, {
          method: "POST",
          body: { name, description: description.character },
        });
        toast.success(`Character "${name}" created from the image`);
      } else if (applyTo) {
        await api(`/locations/${applyTo}/versions`, {
          method: "POST",
          body: {
            description: description.location,
            changeNote: "From a reference image",
            makeCurrent: true,
          },
        });
        toast.success("New location version created from the image");
      } else {
        const name = window.prompt("Name this location", description.location?.kind || "New location");
        if (!name) return;
        await api(`/projects/${projectId}/locations`, {
          method: "POST",
          body: { name, description: description.location },
        });
        toast.success(`Location "${name}" created from the image`);
      }
      await qc.invalidateQueries();
    } catch (e) {
      toast.error(e);
    } finally {
      setApplying(null);
    }
  };

  const applyButton = (kind: "style" | "character" | "location", label: string) => {
    if (onUse)
      return (
        <button type="button" className="btn-secondary px-2 py-1 text-xs" onClick={() => onUse(description!)}>
          <Wand2 className="size-3.5" /> Use this
        </button>
      );
    // A character or location can go either way: a brand new one, or a new version of one that already exists.
    // A version rather than an edit, so the previous description stays in the history to compare against.
    const existing = kind === "character" ? cast.data?.characters : kind === "location" ? world.data?.locations : null;
    return (
      <span className="flex items-center gap-1">
        {existing?.length ? (
          <select
            className="input h-7 w-32 py-0 text-xs"
            defaultValue=""
            disabled={applying !== null}
            aria-label={`Update an existing ${kind} from this image`}
            onChange={(e) => {
              const id = e.target.value;
              e.target.value = "";
              if (id) apply(kind, id);
            }}
          >
            <option value="">Update existing…</option>
            {existing.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="btn-secondary px-2 py-1 text-xs"
          disabled={applying !== null}
          onClick={() => apply(kind)}
        >
          {applying === kind ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />} {label}
        </button>
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const dropped = e.dataTransfer.files?.[0];
              if (dropped?.type.startsWith("image/")) setFile(dropped);
            }}
            className={clsx(
              "flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border-2 border-dashed",
              previewUrl ? "border-transparent" : "border-[var(--border)] hover:border-accent-500",
            )}
          >
            {previewUrl ? (
              <img src={previewUrl} alt="" className="h-full w-full object-contain" />
            ) : (
              <span className="muted flex flex-col items-center gap-1 p-4 text-center text-sm">
                <Upload className="size-5" />
                Drop an image here, or click to choose
                <span className="text-xs">PNG, JPEG or WebP</span>
              </span>
            )}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <p className="muted truncate text-xs">
              {file.name} · {(file.size / 1024).toFixed(0)} KB
            </p>
          )}
          <Field label="What is this image? (optional)">
            <input
              className="input"
              placeholder="frame from a trailer"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </Field>
        </div>

        <div className="space-y-3">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <span className="label">Extract</span>
              <span className="muted text-xs">{picked.length} selected</span>
              {picked.length > 0 && (
                <button type="button" className="btn-ghost ml-auto px-2 py-0.5 text-xs" onClick={() => setPicked([])}>
                  Clear
                </button>
              )}
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {offered.map((a) => (
                <AspectCard key={a.key} aspect={a} on={picked.includes(a.key)} toggle={() => toggle(a.key)} />
              ))}
            </div>
          </div>
          <Field label="Anything else to ask about the image? (optional)">
            <textarea
              className="input min-h-20"
              placeholder="What lens and aperture would reproduce this depth of field?"
              value={custom}
              maxLength={2000}
              onChange={(e) => setCustom(e.target.value)}
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <AiChip cap="text" />
            <span className="muted text-xs">Needs a vision-capable model</span>
            <button
              type="button"
              className="btn-primary ml-auto"
              disabled={!file || busy || (picked.length === 0 && !custom.trim())}
              onClick={run}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              {busy ? "Reading the image…" : "Describe image"}
            </button>
          </div>
          <ErrorBox error={error} />
        </div>
      </div>

      {description && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-medium">What the model saw</h2>
            {reusedFrom && (
              <span className="chip bg-sky-500/15 text-xs text-sky-700 dark:text-sky-300">
                reused from {reusedFrom.projectTitle} — nothing was spent
              </span>
            )}
          </div>
          {description.overview && <ResultCard title="Overview" value={description.overview} />}
          <div className="grid gap-3 xl:grid-cols-2">
            {description.style && (
              <ResultCard
                title="Art style"
                value={description.style}
                actions={applyButton("style", "Use as project style")}
              />
            )}
            {description.character && (
              <ResultCard
                title="Character"
                value={description.character}
                actions={applyButton("character", "Create character")}
              />
            )}
            {description.location && (
              <ResultCard
                title="Location"
                value={description.location}
                actions={applyButton("location", "Create location")}
              />
            )}
            {description.outfit && <ResultCard title="Outfit" value={description.outfit} />}
            {description.lighting && <ResultCard title="Lighting & palette" value={description.lighting} />}
            {description.composition && <ResultCard title="Composition" value={description.composition} />}
            {description.mood && <ResultCard title="Mood & tone" value={description.mood} />}
            {description.props && <ResultCard title="Props & objects" value={description.props} />}
            {description.era && <ResultCard title="Era & culture" value={description.era} />}
            {description.technique && <ResultCard title="Medium & technique" value={description.technique} />}
            {description.custom && <ResultCard title="Your question" value={description.custom} />}
          </div>
          {description.uncertain?.length > 0 && (
            <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
              Could not tell from the image: {description.uncertain.join("; ")}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
