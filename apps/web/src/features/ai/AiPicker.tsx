import { type AiCapability, PROVIDER_CATALOG, type ProviderKind, providerCatalog } from "@openmanga/domain/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cpu, KeyRound, Trash2 } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { del, get, post } from "../../api/client.ts";
import { ConfirmDialog, clsx, ErrorBox, Field, fmt, Spinner, toast } from "../../components/ui.tsx";

export type Credential = {
  id: string;
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  keyHint: string;
  lastUsedAt: string | null;
  createdAt: string;
};
type AiOptions = {
  defaults: {
    /** null unless the server runs in demo (mock) mode: keys are your own. */
    text: { provider: string; model: string } | null;
    image: { provider: string; model: string; quality: string } | null;
    tts: { provider: string } | null;
  };
  mockMode: boolean;
  credentials: Credential[];
};
type Choice = {
  credentialId: string | null;
  provider?: ProviderKind | null;
  model: string;
  voice?: string;
  /** Text only: run with no provider at all and answer the prompt by hand. */
  manual?: boolean;
};

export const aiOptionsKey = ["ai-options"] as const;
export const useAiOptions = () =>
  useQuery({ queryKey: aiOptionsKey, queryFn: () => get<AiOptions>("/ai/options"), staleTime: 60_000 });

/** Last provider/model per capability, remembered in this browser (keys themselves live on the server). */
export const useAiChoices = create<{
  text: Choice;
  image: Choice;
  tts: Choice;
  set: (cap: AiCapability, c: Partial<Choice>) => void;
}>()(
  persist(
    (set) => ({
      text: { credentialId: null, model: "" },
      image: { credentialId: null, model: "" },
      tts: { credentialId: null, model: "", voice: "" },
      set: (cap, c) => set((s) => ({ [cap]: { ...s[cap], ...c } })),
    }),
    { name: "mf-ai-choices" },
  ),
);

const supports = (kind: ProviderKind, cap: AiCapability) => {
  const p = providerCatalog(kind);
  if (!p) return false;
  if (p.kind === "openai_compatible") return true;
  return (cap === "text" ? p.textModels : cap === "image" ? p.imageModels : p.ttsModels).length > 0;
};

/**
 * The key a run will actually use: the remembered one, else the first usable one when the server has no default
 * of its own (the normal BYOK case — otherwise a run would 422 until the user opened the picker).
 */
export function effectiveCredential(cap: AiCapability, c: Choice, o: AiOptions | undefined) {
  const creds = (o?.credentials ?? []).filter((x) => supports(x.kind, cap));
  return creds.find((x) => x.id === c.credentialId) ?? (o && !o.defaults[cap] ? creds[0] : undefined) ?? null;
}

/**
 * Request body fragment for the current choice of a capability. Falls back to the server default when the
 * remembered key was deleted. For narration voice, also returns the chosen voice.
 */
export function aiBody(cap: AiCapability, o: AiOptions | undefined) {
  const c = useAiChoices.getState()[cap];
  // Manual answers nothing about a provider, so it has to short-circuit before any credential is considered:
  // the whole point is that there is no key to fall back to.
  if (cap === "text" && c.manual) return { ai: { manual: true } };
  const valid = effectiveCredential(cap, c, o)?.id ?? null;
  if (!valid && !c.model.trim()) return {};
  const body: { ai: { credentialId: string | null; model: string | null }; voice?: string } = {
    ai: { credentialId: valid, model: c.model.trim() || null },
  };
  if (cap === "tts" && valid && c.voice) body.voice = c.voice;
  return body;
}

/** Hook form of aiBody that re-renders when the choice or saved keys change. */
export function useAiBody(cap: AiCapability) {
  const opts = useAiOptions();
  useAiChoices((s) => s[cap]);
  return () => aiBody(cap, opts.data);
}

function choiceLabel(cap: AiCapability, c: Choice, o: AiOptions | undefined) {
  if (cap === "text" && c.manual) return "Paste it yourself · no key";
  const cred = effectiveCredential(cap, c, o);
  if (cred) {
    const cat = providerCatalog(cred.kind);
    const models = cap === "text" ? cat?.textModels : cap === "image" ? cat?.imageModels : cat?.ttsModels;
    return `${cred.label} · ${c.model || models?.[0] || "model?"}`;
  }
  if (!o) return "…";
  if (cap === "tts") return `Local · ${o.defaults.tts?.provider ?? "disabled"}`;
  const d = o.defaults[cap];
  if (!d) return "No key selected";
  return `Demo · ${d.provider} · ${c.model || d.model}`;
}

/** Provider + model (and voice for narration) selector for one capability. */
export function ModelPicker({ cap }: { cap: AiCapability }) {
  const id = useId();
  const opts = useAiOptions();
  const choice = useAiChoices((s) => s[cap]);
  const setChoice = useAiChoices((s) => s.set);
  const creds = (opts.data?.credentials ?? []).filter((c) => supports(c.kind, cap));
  const cred = effectiveCredential(cap, choice, opts.data);
  const models = useQuery({
    queryKey: ["ai-models", cred?.id, cap],
    queryFn: () => get<{ models: string[] }>(`/ai/credentials/${cred!.id}/models?capability=${cap}`),
    enabled: Boolean(cred) && cap !== "tts",
    staleTime: 10 * 60_000,
    retry: false,
  });
  const ttsModelsQ = useQuery({
    queryKey: ["ai-models", cred?.id, "tts"],
    queryFn: () => get<{ models: string[] }>(`/ai/credentials/${cred!.id}/models?capability=tts`),
    enabled: Boolean(cred) && cap === "tts",
    staleTime: 10 * 60_000,
    retry: false,
  });
  const voices = useQuery({
    queryKey: ["ai-voices", cred?.id ?? "default", choice.model],
    queryFn: () =>
      get<{ voices: { id: string; name: string; language: string; gender?: string }[] }>(
        cred ? `/ai/voices?credentialId=${cred.id}&model=${encodeURIComponent(choice.model)}` : "/ai/voices",
      ),
    enabled: cap === "tts" && Boolean(cred),
    staleTime: 10 * 60_000,
    retry: false,
  });
  const cat = cred ? providerCatalog(cred.kind) : null;
  const suggestions =
    (cap === "tts" ? ttsModelsQ.data?.models : models.data?.models) ??
    (cap === "text" ? cat?.textModels : cap === "image" ? cat?.imageModels : cat?.ttsModels) ??
    [];
  const d = opts.data?.defaults;
  const defaultModel = cap === "tts" ? "" : (d?.[cap]?.model ?? "");
  const listErr = (cap === "tts" ? ttsModelsQ.error : models.error) ?? voices.error;

  return (
    <div className="space-y-2 text-sm">
      <Field label={cap === "text" ? "Text provider" : cap === "image" ? "Image provider" : "Voice provider"}>
        <select
          className="input"
          value={choice.manual ? "manual" : (cred?.id ?? "")}
          onChange={(e) =>
            setChoice(cap, {
              credentialId: e.target.value === "manual" ? null : e.target.value || null,
              provider: null,
              model: "",
              voice: "",
              manual: e.target.value === "manual",
            })
          }
        >
          <option value="">
            {cap === "tts"
              ? `Local ${d?.tts?.provider ?? "TTS"}`
              : opts.data?.mockMode
                ? "Demo provider (mock)"
                : creds.length
                  ? "Select a key…"
                  : "No key added yet"}
          </option>
          {creds.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} — {providerCatalog(c.kind)?.label} {c.keyHint}
            </option>
          ))}
          {/* Text only: an image cannot be pasted back as text, so a panel takes an upload instead. */}
          {cap === "text" && <option value="manual">Paste it yourself — no key needed</option>}
        </select>
      </Field>
      {(cap !== "tts" || cred) && (
        <Field label="Model">
          <input
            className="input"
            list={`${id}-models`}
            placeholder={cred ? (suggestions[0] ?? "model id") : defaultModel}
            value={choice.model}
            onChange={(e) => setChoice(cap, { model: e.target.value })}
          />
          <datalist id={`${id}-models`}>
            {(cred ? suggestions : [defaultModel]).map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </Field>
      )}
      {cap === "tts" && cred && (
        <Field label="Voice">
          <select
            className="input"
            value={choice.voice ?? ""}
            onChange={(e) => setChoice("tts", { voice: e.target.value })}
            disabled={voices.isLoading}
          >
            <option value="">{voices.isLoading ? "Loading voices…" : "First available voice"}</option>
            {voices.data?.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.language ? ` · ${v.language}` : ""}
                {v.gender ? ` · ${v.gender}` : ""}
              </option>
            ))}
          </select>
        </Field>
      )}
      {cap === "tts" && !cred && (
        <p className="muted text-xs">Uses the project's default voice and speed below (local Kokoro).</p>
      )}
      {listErr ? (
        <p className="text-xs text-amber-600">Couldn't list models/voices: {String((listErr as Error).message)}</p>
      ) : null}
      {!creds.length && cap !== "tts" && (
        <p className="text-xs text-amber-600">
          This server has no shared API keys.{" "}
          <Link to="/account" className="underline">
            Add your own API keys
          </Link>{" "}
          to pick OpenAI, Anthropic, Google, Meta, OpenRouter, ElevenLabs and more.
        </p>
      )}
    </div>
  );
}

/** Compact "via provider · model" button that opens the picker; place it next to a generate button. */
export function AiChip({ cap, className }: { cap: AiCapability; className?: string }) {
  const opts = useAiOptions();
  const choice = useAiChoices((s) => s[cap]);
  const [open, setOpen] = useState(false);
  // Chips often sit in a modal footer, where a popover below the button falls outside the viewport.
  const [up, setUp] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);
  return (
    <div ref={ref} className={clsx("relative inline-block", className)}>
      <button
        type="button"
        className="btn-ghost max-w-64 truncate px-2 py-1 text-xs"
        aria-expanded={open}
        aria-label={`${cap} model: ${choiceLabel(cap, choice, opts.data)}`}
        title="Choose provider and model for this run"
        onClick={(e) => {
          setUp(e.currentTarget.getBoundingClientRect().bottom + 300 > window.innerHeight);
          setOpen((o) => !o);
        }}
      >
        <Cpu className="size-3.5 shrink-0" />
        <span className="truncate">{choiceLabel(cap, choice, opts.data)}</span>
      </button>
      {open && (
        <div
          className={clsx(
            "card absolute right-0 z-30 w-80 max-w-[90vw] p-3 shadow-xl",
            up ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          <ModelPicker cap={cap} />
        </div>
      )}
    </div>
  );
}

/** Account settings: bring-your-own-key management. */
export function ProviderKeys() {
  const qc = useQueryClient();
  const opts = useAiOptions();
  const [form, setForm] = useState<{ kind: ProviderKind; label: string; apiKey: string; baseUrl: string }>({
    kind: "openai",
    label: "",
    apiKey: "",
    baseUrl: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<Credential | null>(null);
  const cat = providerCatalog(form.kind)!;
  const caps = (k: ProviderKind) =>
    (["text", "image", "tts"] as const).filter((c) => supports(k, c)).map((c) => (c === "tts" ? "voice" : c));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await post("/ai/credentials", {
        kind: form.kind,
        label: form.label,
        apiKey: form.apiKey,
        baseUrl: form.kind === "openai_compatible" ? form.baseUrl : null,
      });
      setForm({ ...form, label: "", apiKey: "", baseUrl: "" });
      toast.success("Key verified and saved");
      await qc.invalidateQueries({ queryKey: aiOptionsKey });
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card space-y-3 p-4">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4" />
        <h2 className="font-medium">AI providers (bring your own key)</h2>
      </div>
      <p className="muted text-xs">
        Add keys to choose a provider and model for each text, image or narration run. Keys are verified with the
        provider, stored encrypted on the server, never shown again and only usable by you. Without keys, the server's
        configured providers are used. Usage on your keys is billed by the provider to you.
      </p>
      {opts.isLoading && <Spinner />}
      <ErrorBox error={opts.error} />
      {opts.data?.credentials.length ? (
        <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {opts.data.credentials.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 p-2 text-sm">
              <span className="font-medium">{c.label}</span>
              <span className="chip">{providerCatalog(c.kind)?.label}</span>
              <span className="muted font-mono text-xs">{c.keyHint}</span>
              <span className="muted text-xs">{caps(c.kind).join(" · ")}</span>
              {c.baseUrl && <span className="muted truncate text-xs">{c.baseUrl}</span>}
              <span className="muted ml-auto text-xs">
                {c.lastUsedAt ? `used ${fmt.ago(c.lastUsedAt)}` : `added ${fmt.ago(c.createdAt)}`}
              </span>
              <button
                type="button"
                className="btn-ghost p-1 text-red-500"
                aria-label={`Delete key ${c.label}`}
                onClick={() => setRemoving(c)}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !opts.isLoading && <p className="muted text-sm">No keys yet.</p>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Provider">
          <select
            className="input"
            value={form.kind}
            onChange={(e) => setForm({ ...form, kind: e.target.value as ProviderKind })}
          >
            {PROVIDER_CATALOG.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label} ({caps(p.kind).join(", ")})
              </option>
            ))}
          </select>
        </Field>
        <Field label="Label (optional)">
          <input
            className="input"
            placeholder={cat.label}
            value={form.label}
            maxLength={80}
            onChange={(e) => setForm({ ...form, label: e.target.value })}
          />
        </Field>
        {form.kind === "openai_compatible" && (
          <div className="sm:col-span-2">
            <Field label="Base URL (public https, OpenAI-compatible)">
              <input
                className="input"
                placeholder="https://api.example.com/v1"
                value={form.baseUrl}
                onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              />
            </Field>
          </div>
        )}
        <div className="sm:col-span-2">
          <Field label="API key">
            <input
              className="input font-mono"
              type="password"
              autoComplete="off"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
            />
          </Field>
          {cat.keyUrl && (
            <a className="muted text-xs underline" href={cat.keyUrl} target="_blank" rel="noreferrer">
              Get a {cat.label} key
            </a>
          )}
        </div>
      </div>
      <ErrorBox error={error} />
      <button
        type="button"
        className="btn-primary"
        disabled={busy || form.apiKey.trim().length < 8 || (form.kind === "openai_compatible" && !form.baseUrl.trim())}
        onClick={save}
      >
        {busy && <Spinner />} Verify and save key
      </button>
      <ConfirmDialog
        open={Boolean(removing)}
        danger
        title={`Delete key "${removing?.label}"?`}
        confirmLabel="Delete key"
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          try {
            await del(`/ai/credentials/${removing!.id}`);
            await qc.invalidateQueries({ queryKey: aiOptionsKey });
            toast.success("Key deleted");
          } catch (e) {
            toast.error(e);
          }
          setRemoving(null);
        }}
      >
        Queued jobs that use this key will fail. Runs switch back to the server default provider.
      </ConfirmDialog>
    </section>
  );
}
