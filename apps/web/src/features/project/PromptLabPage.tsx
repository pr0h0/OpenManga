import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { clsx, ErrorBox, Field, fmt, PageHeader, Spinner } from "../../components/ui.tsx";
import { useProjectId } from "./ProjectLayout.tsx";

type Version = { id: string; version: number; note: string; active: boolean; createdAt: string };
type Template = {
  name: string;
  label: string;
  image: boolean;
  builtInVersion: number;
  builtInRules: string;
  active: (Version & { rules: string }) | null;
  versions: Version[];
};
type Diff = { op: "same" | "add" | "remove"; line: string }[];

/**
 * The prompt lab: rewrite a built-in prompt's rules for this project (planning, panel prompts, narration; extra
 * rules for panel images), see the diff and the compiled prompt, keep versions and go back to any of them.
 */
export function PromptLabPage() {
  const projectId = useProjectId();
  const key = ["project", projectId, "prompt-lab"];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ templates: Template[] }>(`/projects/${projectId}/prompt-lab`),
  });
  const [name, setName] = useState<string | null>(null);
  const t = q.data?.templates.find((x) => x.name === (name ?? q.data?.templates[0]?.name));
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Prompt lab"
        subtitle="Rewrite the rules of a built-in prompt for this project. Story content stays data and the answer format stays fixed; every job records the version it used."
      />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && (
        <div className="grid gap-4 md:grid-cols-[16rem_1fr]">
          <ul className="space-y-1" aria-label="Prompts">
            {q.data.templates.map((x) => (
              <li key={x.name}>
                <button
                  type="button"
                  onClick={() => setName(x.name)}
                  className={clsx(
                    "w-full rounded-lg border p-2 text-left text-sm",
                    x.name === t?.name ? "border-accent-500 bg-[var(--panel-2)]" : "border-[var(--border)]",
                  )}
                >
                  <div className="font-medium">{x.label}</div>
                  <div className="muted text-xs">
                    {x.active ? `Project rules v${x.active.version}` : `Built-in v${x.builtInVersion}`}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {t && <Editor key={`${t.name}-${t.active?.version ?? 0}`} projectId={projectId} t={t} invalidate={key} />}
        </div>
      )}
    </div>
  );
}

function Editor({ projectId, t, invalidate }: { projectId: string; t: Template; invalidate: unknown[] }) {
  const qc = useQueryClient();
  const [rules, setRules] = useState(t.active?.rules ?? t.builtInRules);
  const [note, setNote] = useState("");
  const [chapterId, setChapterId] = useState("");
  const [panelIds, setPanelIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<{
    system?: string;
    panels?: { panelId: string; prompt: string }[];
    diff: Diff;
  } | null>(null);
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
    select: (r) => r.chapters,
    enabled: t.image,
  });
  const panels = useQuery({
    queryKey: ["chapter", chapterId, "panels"],
    queryFn: () =>
      get<{ panels: { id: string; order: number; pageOrder: number; storyBeat: string }[] }>(
        `/chapters/${chapterId}/panels`,
      ),
    select: (r) => r.panels,
    enabled: t.image && Boolean(chapterId),
  });
  const done = () => void qc.invalidateQueries({ queryKey: invalidate });
  const run = useAction(
    () => post<NonNullable<typeof preview>>(`/projects/${projectId}/prompt-lab/${t.name}/preview`, { rules, panelIds }),
    { onSuccess: setPreview },
  );
  const save = useAction(() => post(`/projects/${projectId}/prompt-lab/${t.name}`, { rules, note }), {
    success: "Saved and in use for this project",
    onSuccess: done,
  });
  const activate = useAction(
    (version: number) => post(`/projects/${projectId}/prompt-lab/${t.name}/activate`, { version }),
    {
      success: (_r) => "Switched",
      onSuccess: done,
    },
  );
  return (
    <section className="space-y-3" aria-label={t.label}>
      <Field
        label={t.image ? "Project rules added to every panel image prompt" : "Rules"}
        hint={
          t.image
            ? "Extra direction and exclusions, e.g. “No blood is shown.” or “Keep every sky overcast.”"
            : `Built-in v${t.builtInVersion}'s rules to start from. The template header, the data rule and the answer format are added for you.`
        }
      >
        <textarea
          className="input min-h-72 font-mono text-xs"
          value={rules}
          onChange={(e) => setRules(e.target.value)}
        />
      </Field>
      {t.image && (
        <div className="flex flex-wrap items-end gap-2 text-sm">
          <Field label="Try it on panels of">
            <select
              className="input"
              value={chapterId}
              onChange={(e) => {
                setChapterId(e.target.value);
                setPanelIds([]);
              }}
            >
              <option value="">Chapter…</option>
              {chapters.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  ch. {c.order}: {c.title}
                </option>
              ))}
            </select>
          </Field>
          <div className="flex max-h-24 flex-wrap gap-1 overflow-auto">
            {panels.data?.map((p) => (
              <label key={p.id} className="chip cursor-pointer text-xs">
                <input
                  type="checkbox"
                  className="mr-1"
                  checked={panelIds.includes(p.id)}
                  disabled={!panelIds.includes(p.id) && panelIds.length >= 3}
                  onChange={(e) =>
                    setPanelIds((ids) => (e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id)))
                  }
                />
                p{p.pageOrder}·{p.order}
              </label>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn-secondary"
          disabled={run.isPending || (t.image && !panelIds.length)}
          onClick={() => run.mutate()}
        >
          Preview
        </button>
        <input
          className="input w-60"
          placeholder="Note for this version"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary"
          disabled={save.isPending || !rules.trim()}
          onClick={() => save.mutate()}
        >
          Save as v{(t.versions[0]?.version ?? 0) + 1} and use it
        </button>
      </div>
      {preview && (
        <div className="grid gap-3 lg:grid-cols-2">
          <section aria-label="Diff">
            <div className="label">Changes from the built-in</div>
            <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--border)] p-2 text-[11px] whitespace-pre-wrap">
              {preview.diff
                .filter((d) => d.op !== "same")
                .map((d, i) => (
                  <div key={i} className={d.op === "add" ? "text-emerald-600" : "text-red-500 line-through"}>
                    {d.op === "add" ? "+ " : "- "}
                    {d.line}
                  </div>
                ))}
              {preview.diff.every((d) => d.op === "same") && <span className="muted">No changes.</span>}
            </pre>
          </section>
          <section aria-label="Compiled prompt">
            <div className="label">Compiled prompt</div>
            <pre className="max-h-80 overflow-auto rounded-lg border border-[var(--border)] p-2 text-[11px] whitespace-pre-wrap">
              {preview.system ??
                preview.panels?.map((p) => `— panel ${p.panelId.slice(0, 8)} —\n${p.prompt}`).join("\n\n")}
            </pre>
          </section>
        </div>
      )}
      <div>
        <div className="label">Versions</div>
        <ul className="space-y-1 text-sm">
          <li className="flex items-center gap-2">
            <span className="mr-auto">Built-in v{t.builtInVersion}</span>
            {t.active ? (
              <button type="button" className="btn-ghost text-xs" onClick={() => activate.mutate(0)}>
                Use the built-in
              </button>
            ) : (
              <span className="chip text-xs">in use</span>
            )}
          </li>
          {t.versions.map((v) => (
            <li key={v.id} className="flex items-center gap-2">
              <span className="mr-auto">
                v{v.version}{" "}
                <span className="muted text-xs">
                  · {fmt.ago(v.createdAt)}
                  {v.note ? ` · ${v.note}` : ""}
                </span>
              </span>
              {v.active ? (
                <span className="chip text-xs">in use</span>
              ) : (
                <button type="button" className="btn-ghost text-xs" onClick={() => activate.mutate(v.version)}>
                  Use v{v.version}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
