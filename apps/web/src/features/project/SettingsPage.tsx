import { BUILTIN_LETTERING, resolveLettering } from "@openmanga/domain/browser";
import type { BubbleType, LetteringDefaults, LetteringStyle, ProjectSettings, SfxDefaults } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { qk, useMeta } from "../../api/hooks.ts";
import type { TtsStatus } from "../../api/types.ts";
import { ConfirmDialog, Field, PageHeader, SaveIndicator, toast, useAutosave } from "../../components/ui.tsx";
import { useAiOptions } from "../ai/AiPicker.tsx";
import { useProject, useProjectId } from "./ProjectLayout.tsx";

type Form = {
  title: string;
  description: string;
  projectType: string;
  language: string;
  readingDirection: string;
  colorMode: string;
  settings: ProjectSettings;
};

export function SettingsPage() {
  const projectId = useProjectId();
  const { data } = useProject();
  const qc = useQueryClient();
  const meta = useMeta();
  const navigate = useNavigate();
  const tts = useQuery({ queryKey: ["tts-status"], queryFn: () => get<TtsStatus>("/tts/status"), staleTime: 60_000 });
  const [form, setForm] = useState<Form | null>(null);
  const [confirm, setConfirm] = useState<null | "archive" | "trash">(null);
  useEffect(() => {
    if (data && !form) {
      const p = data.project;
      setForm({
        title: p.title,
        description: p.description,
        projectType: p.projectType,
        language: p.language,
        readingDirection: p.readingDirection,
        colorMode: p.colorMode,
        settings: p.settings,
      });
    }
  }, [data, form]);
  const { state } = useAutosave(
    form,
    async (v) => {
      if (!v) return;
      await patch(`/projects/${projectId}`, v);
      await qc.invalidateQueries({ queryKey: qk.project(projectId) });
    },
    { enabled: Boolean(form) },
  );
  if (!form || !data) return null;
  const s = form.settings;
  const set = (k: keyof Form, v: string) => setForm({ ...form, [k]: v });
  const setS = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) =>
    setForm({ ...form, settings: { ...form.settings, [k]: v } });
  const num = (k: keyof ProjectSettings, min: number, max: number, step = 1) => (
    <input
      className="input"
      type="number"
      min={min}
      max={max}
      step={step}
      value={Number(s[k] ?? "")}
      onChange={(e) => e.target.value !== "" && setS(k, Number(e.target.value) as never)}
    />
  );
  const refDefault = meta.data?.referenceDefaults;
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title="Project settings"
        subtitle="Changes save automatically."
        actions={<SaveIndicator state={state} />}
      />
      <div className="space-y-4">
        <section className="card grid gap-3 p-4 sm:grid-cols-2">
          <h2 className="font-medium sm:col-span-2">General</h2>
          <Field label="Title">
            <input className="input" value={form.title} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field label="Language">
            <input className="input" value={form.language} onChange={(e) => set("language", e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Description">
              <textarea
                className="input min-h-16"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Project type">
            <select className="input" value={form.projectType} onChange={(e) => set("projectType", e.target.value)}>
              {["manhwa", "manga", "webtoon", "comic", "illustrated_story"].map((t) => (
                <option key={t} value={t}>
                  {t.replace("_", " ")}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Reading direction">
            <select
              className="input"
              value={form.readingDirection}
              onChange={(e) => set("readingDirection", e.target.value)}
            >
              <option value="ltr">Left to right</option>
              <option value="rtl">Right to left</option>
              <option value="vertical">Vertical</option>
            </select>
          </Field>
          <Field label="Color mode" hint="Becomes a prompt directive">
            <select className="input" value={form.colorMode} onChange={(e) => set("colorMode", e.target.value)}>
              <option value="full_color">Full color</option>
              <option value="grayscale">Grayscale</option>
              <option value="bw_manga">Black & white manga</option>
            </select>
          </Field>
          <Field label="Author (used on covers)">
            <input className="input" value={s.author} onChange={(e) => setS("author", e.target.value)} />
          </Field>
          <p className="muted text-xs sm:col-span-2">Art preset and style references are managed in World → Style.</p>
        </section>

        <section className="card grid gap-3 p-4 sm:grid-cols-3">
          <h2 className="font-medium sm:col-span-3">
            {s.format === "film" ? "Shots & generation" : "Pages & generation"}
          </h2>
          {s.format === "film" ? (
            <p className="muted text-sm sm:col-span-3">
              Narrated video project: every page is one full-frame 16:9 shot (1920×1080, no margins), planned as a shot
              list and exported as a Ken Burns video. The format can't change once pages exist.
            </p>
          ) : (
            <>
              <Field label="Default page width (px)">{num("pageWidth", 256, 8000)}</Field>
              <Field label="Default page height (px)">{num("pageHeight", 256, 20000)}</Field>
            </>
          )}
          <Field
            label="AI budget cap (USD)"
            hint="Generation stops and asks once this project's spend reaches it. Empty = no cap."
          >
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              placeholder="No cap"
              value={s.budgetUsd ?? ""}
              onChange={(e) => setS("budgetUsd", e.target.value === "" ? null : Math.max(0, Number(e.target.value)))}
            />
          </Field>
          <Field label="Panel generation quality" hint="LOW is the intended default">
            <select
              className="input"
              value={s.imageQuality}
              onChange={(e) => setS("imageQuality", e.target.value as ProjectSettings["imageQuality"])}
            >
              <option value="low">Low (recommended)</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
          {s.format !== "film" && (
            <>
              <Field label="Page margin (0–0.2)">{num("pageMargin", 0, 0.2, 0.005)}</Field>
              <Field label="Panel gutter (0–0.1)">{num("pageGutter", 0, 0.1, 0.005)}</Field>
              <div />
            </>
          )}
          <Field label="Reference derivative max width" hint={`Server default ${refDefault?.maxWidth ?? 192}`}>
            <input
              className="input"
              type="number"
              min={16}
              max={2048}
              placeholder={String(refDefault?.maxWidth ?? 192)}
              value={s.referenceMaxWidth ?? ""}
              onChange={(e) => setS("referenceMaxWidth", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
          <Field label="Reference derivative max height" hint={`Server default ${refDefault?.maxHeight ?? 288}`}>
            <input
              className="input"
              type="number"
              min={16}
              max={2048}
              placeholder={String(refDefault?.maxHeight ?? 288)}
              value={s.referenceMaxHeight ?? ""}
              onChange={(e) => setS("referenceMaxHeight", e.target.value ? Number(e.target.value) : undefined)}
            />
          </Field>
          <p className="muted text-xs sm:col-span-3">
            Only small reference derivatives are sent with image requests; canonical references stay full resolution.
            Change the size to run cost/consistency experiments (see Cost → reference size experiments).
          </p>
        </section>

        <section className="card grid gap-3 p-4 sm:grid-cols-3">
          <h2 className="font-medium sm:col-span-3">Narration & webtoon</h2>
          <Field label="Narration voice">
            <select className="input" value={s.narrationVoice} onChange={(e) => setS("narrationVoice", e.target.value)}>
              {(tts.data?.voices.length
                ? tts.data.voices
                : [{ id: s.narrationVoice, name: s.narrationVoice, language: "" }]
              ).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} {v.language && `(${v.language})`}
                </option>
              ))}
            </select>
          </Field>
          <Field label={`Narration speed (${s.narrationSpeed.toFixed(2)}×)`}>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={s.narrationSpeed}
              onChange={(e) => setS("narrationSpeed", Number(e.target.value))}
              className="w-full"
            />
          </Field>
          <Field
            label="Narration words per panel"
            hint={`≈${Math.round(((s.narrationWordsPerPanel ?? 21) / 210) * 60)} s of speech per panel`}
          >
            {num("narrationWordsPerPanel", 5, 80)}
          </Field>
          <Field label="Pause after narration (ms)" hint="Silence after each narration segment">
            {num("narrationPauseMs", 0, 5000)}
          </Field>
          <Field label="Pause at scene/chapter end (ms)" hint="Longer break after the last line of a scene">
            {num("sceneBreakPauseMs", 0, 10000)}
          </Field>
          <Field label="Narration style" hint="Used for every chapter so the voice stays consistent">
            <input
              className="input"
              maxLength={500}
              placeholder="e.g. dry, warm, second person, present tense"
              value={s.narrationStyle ?? ""}
              onChange={(e) => setS("narrationStyle", e.target.value)}
            />
          </Field>
          <Field label="Webtoon width (px)">{num("webtoonWidth", 320, 2000)}</Field>
          <Field label="Webtoon panel gap (px)">{num("webtoonGap", 0, 1000)}</Field>
          <Field label="Webtoon max chunk height (px)">{num("webtoonChunkHeight", 1000, 40000)}</Field>
        </section>

        <LetteringSection value={s.lettering} onChange={(v) => setS("lettering", v)} />

        <ConsistencySection value={s.consistencyCheck} onChange={(v) => setS("consistencyCheck", v)} />

        <FallbackSection value={s.contentPolicyFallback} onChange={(v) => setS("contentPolicyFallback", v)} />

        <section className="card flex flex-wrap items-center gap-2 border-red-500/30 p-4">
          <h2 className="mr-auto font-medium">Danger zone</h2>
          <button type="button" className="btn-secondary" onClick={() => setConfirm("archive")}>
            {data.project.status === "archived" ? "Unarchive" : "Archive"} project
          </button>
          <button type="button" className="btn-danger" onClick={() => setConfirm("trash")}>
            Move to trash
          </button>
        </section>
      </div>
      <ConfirmDialog
        open={confirm !== null}
        danger={confirm === "trash"}
        title={confirm === "trash" ? "Move project to trash?" : "Change archive state?"}
        confirmLabel="Confirm"
        onClose={() => setConfirm(null)}
        onConfirm={async () => {
          try {
            const action = confirm === "trash" ? "trash" : data.project.status === "archived" ? "unarchive" : "archive";
            await post(`/projects/${projectId}/status`, { action });
            await qc.invalidateQueries({ queryKey: ["projects"] });
            await qc.invalidateQueries({ queryKey: qk.project(projectId) });
            if (action === "trash") navigate({ to: "/" });
          } catch (e) {
            toast.error(e);
          }
          setConfirm(null);
        }}
      >
        {confirm === "trash"
          ? "The project moves to trash and can be restored from the dashboard."
          : "Archived projects are hidden from the recent list but stay fully intact."}
      </ConfirmDialog>
    </div>
  );
}

const FONTS = ["Comic Neue", "DejaVu Sans"];
const TYPE_LABEL: Record<BubbleType, string> = {
  normal: "Speech",
  thought: "Thought",
  shout: "Shout",
  whisper: "Whisper",
  narration: "Narration / caption",
  system: "System box",
};

function LetteringSection({
  value,
  onChange,
}: {
  value: LetteringDefaults | undefined;
  onChange: (v: LetteringDefaults) => void;
}) {
  const l = resolveLettering({ lettering: value });
  const cur = value ?? {};
  const setType = (t: BubbleType, p: Partial<LetteringStyle>) =>
    onChange({ ...cur, types: { ...cur.types, [t]: { ...cur.types?.[t], ...p } } });
  const setSfx = (p: Partial<SfxDefaults>) => onChange({ ...cur, sfx: { ...cur.sfx, ...p } });
  const n = (v: number, set: (v: number) => void, min: number, max: number, step = 1, label = "") => (
    <input
      className="input w-16 px-1 text-xs"
      type="number"
      aria-label={label}
      min={min}
      max={max}
      step={step}
      value={v}
      onChange={(e) => e.target.value !== "" && set(Math.min(max, Math.max(min, Number(e.target.value))))}
    />
  );
  const font = (v: string, set: (v: string) => void, label: string) => (
    <select className="input w-auto text-xs" aria-label={label} value={v} onChange={(e) => set(e.target.value)}>
      {FONTS.map((f) => (
        <option key={f}>{f}</option>
      ))}
    </select>
  );
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Lettering defaults</h2>
        <button type="button" className="btn-ghost text-xs" onClick={() => onChange({})}>
          Reset to built-in
        </button>
      </div>
      <p className="muted text-xs">
        Used for new bubbles, captions and SFX (including AI-planned chapters). Font sizes are in page pixels (pages are
        usually 1024–1600 px wide). To update existing text, use Editor → Lettering → Default styles.
      </p>
      <label className="flex items-start gap-2 rounded-lg border border-[var(--border)] p-3 text-sm">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={l.autoPlace}
          onChange={(e) => onChange({ ...cur, autoPlace: e.target.checked })}
        />
        <span>
          Add speech bubbles, captions and SFX automatically when planning chapters
          <span className="muted block text-xs">
            Off: pages get clean artwork only, and panel prompts don't reserve empty space for text. The plan's dialogue
            and SFX are kept: Editor → Lettering → Letter from plan places them later. Narration lines are still created
            for audio.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={l.autoFit}
            onChange={(e) => onChange({ ...cur, autoFit: e.target.checked })}
          />
          Auto-fit boxes to their text
        </label>
        <span className="flex items-center gap-2">
          Max box width (% of page)
          {n(Math.round(l.maxWidth * 100), (v) => onChange({ ...cur, maxWidth: v / 100 }), 10, 100, 1, "Max box width")}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="muted text-left">
            <tr>
              <th className="py-1 pr-2 font-normal">Type</th>
              <th className="pr-2 font-normal">Font</th>
              <th className="pr-2 font-normal">Size</th>
              <th className="pr-2 font-normal">Line h.</th>
              <th className="pr-2 font-normal">Padding</th>
              <th className="pr-2 font-normal">Align</th>
              <th className="pr-2 font-normal">Fill</th>
              <th className="pr-2 font-normal">Text</th>
              <th className="pr-2 font-normal">Border</th>
              <th className="font-normal">Border w.</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(BUILTIN_LETTERING.types) as BubbleType[]).map((t) => {
              const st = l.types[t];
              const lbl = TYPE_LABEL[t];
              return (
                <tr key={t} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2 whitespace-nowrap">{lbl}</td>
                  <td className="pr-2">{font(st.font, (font) => setType(t, { font }), `${lbl} font`)}</td>
                  <td className="pr-2">
                    {n(st.fontSize, (fontSize) => setType(t, { fontSize }), 8, 200, 1, `${lbl} font size`)}
                  </td>
                  <td className="pr-2">
                    {n(st.lineHeight, (lineHeight) => setType(t, { lineHeight }), 0.8, 3, 0.05, `${lbl} line height`)}
                  </td>
                  <td className="pr-2">
                    {n(st.padding, (padding) => setType(t, { padding }), 0, 200, 1, `${lbl} padding`)}
                  </td>
                  <td className="pr-2">
                    <select
                      className="input text-xs"
                      aria-label={`${lbl} alignment`}
                      value={st.align}
                      onChange={(e) => setType(t, { align: e.target.value as LetteringStyle["align"] })}
                    >
                      <option value="left">left</option>
                      <option value="center">center</option>
                      <option value="right">right</option>
                    </select>
                  </td>
                  <td className="pr-2">
                    <input
                      type="color"
                      aria-label={`${lbl} fill`}
                      value={st.background}
                      onChange={(e) => setType(t, { background: e.target.value })}
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      type="color"
                      aria-label={`${lbl} text color`}
                      value={st.textColor}
                      onChange={(e) => setType(t, { textColor: e.target.value })}
                    />
                  </td>
                  <td className="pr-2">
                    <input
                      type="color"
                      aria-label={`${lbl} border color`}
                      value={st.borderColor}
                      onChange={(e) => setType(t, { borderColor: e.target.value })}
                    />
                  </td>
                  <td>
                    {n(st.borderWidth, (borderWidth) => setType(t, { borderWidth }), 0, 20, 1, `${lbl} border width`)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--border)] pt-3 text-xs">
        <span className="font-medium">Sound effects</span>
        {font(l.sfx.font, (f) => setSfx({ font: f }), "SFX font")}
        <span className="flex items-center gap-1">
          Size {n(l.sfx.fontSize, (fontSize) => setSfx({ fontSize }), 8, 400, 1, "SFX size")}
        </span>
        <label className="flex items-center gap-1">
          Fill <input type="color" value={l.sfx.fill} onChange={(e) => setSfx({ fill: e.target.value })} />
        </label>
        <label className="flex items-center gap-1">
          Stroke <input type="color" value={l.sfx.stroke} onChange={(e) => setSfx({ stroke: e.target.value })} />
        </label>
        <span className="flex items-center gap-1">
          Stroke w. {n(l.sfx.strokeWidth, (strokeWidth) => setSfx({ strokeWidth }), 0, 30, 1, "SFX stroke width")}
        </span>
      </div>
    </section>
  );
}

/** Opt-in vision QA after each panel generation. Needs a vision-capable model from a saved key. */
function FallbackSection({
  value,
  onChange,
}: {
  value: ProjectSettings["contentPolicyFallback"];
  onChange: (v: NonNullable<ProjectSettings["contentPolicyFallback"]>) => void;
}) {
  const opts = useAiOptions();
  const cur = {
    enabled: true,
    credentialId: null as string | null,
    provider: null as string | null,
    model: "",
    ...value,
  };
  const creds = (opts.data?.credentials ?? []).filter((c) =>
    ["openai", "google", "meta", "openrouter", "openai_compatible"].includes(c.kind),
  );
  const selected = cur.credentialId ?? "";
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-medium">Content filter fallback</h2>
      <p className="muted text-xs">
        When an image provider's content filter blocks a panel, retry it once on another of your keys and mark the panel
        "needs review". Only content-filter blocks trigger this; other failures never switch providers. The retried
        panel may look slightly different, which is why it is flagged. Pick a key below — this server has no shared
        keys.
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cur.enabled}
          onChange={(e) => onChange({ ...cur, enabled: e.target.checked })}
        />
        Retry blocked panels once on the fallback provider
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Fallback provider">
          <select
            className="input"
            value={selected}
            onChange={(e) => onChange({ ...cur, credentialId: e.target.value || null, provider: null, model: "" })}
          >
            <option value="">Select one of your keys…</option>
            {creds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} {c.keyHint}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <input
            className="input"
            placeholder="provider default"
            value={cur.model}
            onChange={(e) => onChange({ ...cur, model: e.target.value })}
          />
        </Field>
      </div>
    </section>
  );
}

function ConsistencySection({
  value,
  onChange,
}: {
  value: ProjectSettings["consistencyCheck"];
  onChange: (v: NonNullable<ProjectSettings["consistencyCheck"]>) => void;
}) {
  const opts = useAiOptions();
  const cur = { enabled: false, credentialId: null as string | null, model: "", ...value };
  const creds = (opts.data?.credentials ?? []).filter((c) =>
    ["openai", "anthropic", "google", "meta", "openrouter", "openai_compatible"].includes(c.kind),
  );
  return (
    <section className="card space-y-3 p-4">
      <h2 className="font-medium">Consistency check (vision QA)</h2>
      <p className="muted text-xs">
        After each panel is generated, a vision model counts the people in the artwork and checks the expected
        characters are there. Mismatches are flagged on the page and in the editor so you can re-roll them. Each check
        is one extra text-model call with a small image. Some text models cannot read images, so pick a key with a
        vision model (for example OpenAI gpt-5-mini, Anthropic Claude, Google Gemini or Meta Muse).
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={cur.enabled}
          onChange={(e) => onChange({ ...cur, enabled: e.target.checked })}
        />
        Check every generated panel automatically
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Vision provider">
          <select
            className="input"
            value={cur.credentialId ?? ""}
            onChange={(e) => onChange({ ...cur, credentialId: e.target.value || null })}
          >
            <option value="">Select one of your keys…</option>
            {creds.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} {c.keyHint}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Model">
          <input
            className="input"
            placeholder="e.g. gpt-5-mini"
            value={cur.model}
            onChange={(e) => onChange({ ...cur, model: e.target.value })}
          />
        </Field>
      </div>
      {!creds.length ? (
        <p className="text-xs text-amber-600">
          Add an API key with a vision model in Account → AI providers to use this.
        </p>
      ) : (
        cur.enabled &&
        !cur.credentialId && <p className="text-xs text-amber-600">Pick a key above, or checks are skipped.</p>
      )}
    </section>
  );
}
