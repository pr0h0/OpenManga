import { NARRATION_LANGUAGES } from "@openmanga/domain/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post, put } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { Spinner, StatusChip } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Line = {
  sourceType: "dialogue" | "caption";
  sourceId: string;
  pageId: string;
  page: number;
  panel: number | null;
  kind: string;
  speaker: string | null;
  text: string;
  translation: string | null;
  stale: boolean;
  edited: boolean;
};
type Data = {
  language: string;
  sourceLanguage: string;
  lines: Line[];
  translated: number;
  job: { id: string; status: string; failureReason: string | null } | null;
};

/**
 * Chapter → Translated lettering: the chapter's bubbles and captions in another language, re-lettered into the same
 * bubbles for a translated edition. Translate with the text model or by hand; preview a page; export it from Exports.
 */
export function TranslatedLettering({
  chapterId,
  projectLanguage,
  firstPageId,
}: {
  chapterId: string;
  projectLanguage: string;
  firstPageId: string | null;
}) {
  const qc = useQueryClient();
  const others = NARRATION_LANGUAGES.filter((l) => l.code !== projectLanguage);
  const [language, setLanguage] = useState(others[0]?.code ?? "es");
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const key = ["chapter", chapterId, "lettering", language];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<Data>(`/chapters/${chapterId}/lettering?language=${language}`),
    enabled: open,
    refetchInterval: (r) =>
      r.state.data?.job && !["completed", "failed", "cancelled"].includes(r.state.data.job.status) ? 3000 : false,
  });
  const aiText = useAiBody("text");
  const translate = useAction(() => post(`/chapters/${chapterId}/lettering/translate`, { language, ...aiText() }), {
    invalidate: [key],
    success: "Translating the lettering",
  });
  const save = useAction(
    () =>
      put(`/chapters/${chapterId}/lettering`, {
        language,
        lines: Object.entries(draft).map(([sourceId, text]) => ({
          sourceId,
          sourceType: q.data!.lines.find((l) => l.sourceId === sourceId)!.sourceType,
          text,
        })),
      }),
    {
      success: "Translations saved",
      onSuccess: () => {
        setDraft({});
        void qc.invalidateQueries({ queryKey: key });
      },
    },
  );
  const d = q.data;
  const pageForPreview = d?.lines[0]?.pageId ?? firstPageId;
  return (
    <details className="card p-4" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer font-semibold">Translated lettering</summary>
      <div className="mt-3 space-y-3 text-sm">
        <p className="muted text-xs">
          The chapter's bubbles and captions in another language, in the same bubbles on the same art. Export a page
          edition in this language from Exports (Lettering language); videos letter in their narration language.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="input w-auto"
            aria-label="Edition language"
            value={language}
            onChange={(e) => {
              setLanguage(e.target.value);
              setDraft({});
            }}
          >
            {others.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
          <AiChip cap="text" />
          <button
            type="button"
            className="btn-secondary"
            disabled={translate.isPending}
            onClick={() => translate.mutate()}
          >
            Translate
          </button>
          {pageForPreview && (
            <a
              className="btn-ghost text-xs"
              href={`/api/pages/${pageForPreview}/render.png?language=${language}`}
              target="_blank"
              rel="noreferrer"
            >
              Preview a page
            </a>
          )}
          {d && (
            <span className="muted ml-auto text-xs">
              {d.translated} of {d.lines.length} translated
            </span>
          )}
        </div>
        {d?.job && d.job.status !== "completed" && (
          <div className="flex items-center gap-2 text-xs">
            <StatusChip status={d.job.status} />{" "}
            {d.job.failureReason && <span className="muted">{d.job.failureReason}</span>}
          </div>
        )}
        {q.isLoading && <Spinner />}
        {d && !d.lines.length && <p className="muted">This chapter has no bubbles or captions yet.</p>}
        {d && d.lines.length > 0 && (
          <div className="max-h-[28rem] overflow-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--panel)]">
                <tr className="text-left">
                  <th className="p-2">Where</th>
                  <th className="p-2">Original</th>
                  <th className="p-2">Translation</th>
                </tr>
              </thead>
              <tbody>
                {d.lines.map((l) => (
                  <tr key={l.sourceId} className="border-t border-[var(--border)] align-top">
                    <td className="muted whitespace-nowrap p-2">
                      p{l.page}
                      {l.panel ? `·${l.panel}` : ""} {l.kind === "caption" ? "caption" : (l.speaker ?? "")}
                    </td>
                    <td className="p-2">{l.text}</td>
                    <td className="p-2">
                      <textarea
                        className="input min-h-8 text-xs"
                        aria-label={`Translation of: ${l.text}`}
                        value={draft[l.sourceId] ?? l.translation ?? ""}
                        onChange={(e) => setDraft((x) => ({ ...x, [l.sourceId]: e.target.value }))}
                      />
                      {l.stale && <span className="text-amber-600">The original changed since</span>}
                      {l.edited && !l.stale && <span className="muted">edited by hand</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {Object.keys(draft).length > 0 && (
          <button type="button" className="btn-primary" disabled={save.isPending} onClick={() => save.mutate()}>
            Save {Object.keys(draft).length} edit{Object.keys(draft).length === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </details>
  );
}
