import type { PronunciationEntry } from "@openmanga/schemas";
import { Plus, Trash2, Volume2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client.ts";
import { toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Row = PronunciationEntry & { key: number };
let nextKey = 0;
const row = (e: Partial<PronunciationEntry> = {}): Row => ({
  term: "",
  spoken: "",
  caseSensitive: false,
  wholeWord: true,
  ...e,
  key: nextKey++,
});

/**
 * How the narrator says names and terms. Rows are edited locally and only complete ones (a term and a spoken form)
 * are saved, so a half-typed row never fails the autosave.
 */
export function PronunciationSection({
  value,
  voice,
  speed,
  onChange,
}: {
  value: PronunciationEntry[];
  voice: string;
  speed: number;
  onChange: (v: PronunciationEntry[]) => void;
}) {
  const [rows, setRows] = useState<Row[]>(() => value.map((e) => row(e)));
  const [playing, setPlaying] = useState<number | null>(null);
  const aiTts = useAiBody("tts");
  const update = (next: Row[]) => {
    setRows(next);
    onChange(
      next
        .filter((r) => r.term.trim() && r.spoken.trim())
        .map(({ key: _, ...e }) => ({ ...e, term: e.term.trim(), spoken: e.spoken.trim() })),
    );
  };
  const edit = (key: number, patch: Partial<PronunciationEntry>) =>
    update(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const preview = async (r: Row) => {
    setPlaying(r.key);
    try {
      const res = await api<Response>("/tts/preview", {
        method: "POST",
        body: { voice, speed, text: r.spoken.trim(), ...aiTts() },
        raw: true,
      });
      const url = URL.createObjectURL(await res.blob());
      const a = new Audio(url);
      a.onended = () => URL.revokeObjectURL(url);
      await a.play();
    } catch (e) {
      toast.error(e);
    } finally {
      setPlaying(null);
    }
  };
  return (
    <section className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Pronunciation</h2>
        <AiChip cap="tts" />
      </div>
      <p className="muted text-xs">
        How the narrator says names and terms. Only the voice hears the spoken form: narration, subtitles and lettering
        keep the written one. Changing an entry marks the audio of the lines it affects as out of date.
      </p>
      {rows.length > 0 && (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="grid gap-2 rounded-lg border border-[var(--border)] p-2 sm:grid-cols-[1fr_1fr_auto]"
            >
              <input
                className="input"
                aria-label="Written term"
                placeholder="Written (e.g. Qi)"
                maxLength={100}
                value={r.term}
                onChange={(e) => edit(r.key, { term: e.target.value })}
              />
              <input
                className="input"
                aria-label="Spoken as"
                placeholder="Spoken (e.g. chee)"
                maxLength={200}
                value={r.spoken}
                onChange={(e) => edit(r.key, { spoken: e.target.value })}
              />
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={r.caseSensitive}
                    onChange={(e) => edit(r.key, { caseSensitive: e.target.checked })}
                  />
                  Match case
                </label>
                <label className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={r.wholeWord}
                    onChange={(e) => edit(r.key, { wholeWord: e.target.checked })}
                  />
                  Whole word
                </label>
                <button
                  type="button"
                  className="btn-ghost p-1"
                  aria-label={`Preview ${r.term || "entry"}`}
                  title="Hear the spoken form with the project's voice"
                  disabled={!r.spoken.trim() || playing !== null}
                  onClick={() => preview(r)}
                >
                  <Volume2 className="size-4" />
                </button>
                <button
                  type="button"
                  className="btn-ghost p-1"
                  aria-label={`Remove ${r.term || "entry"}`}
                  onClick={() => update(rows.filter((x) => x.key !== r.key))}
                >
                  <Trash2 className="size-4" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className="btn-secondary"
        disabled={rows.length >= 500}
        onClick={() => setRows([...rows, row()])}
      >
        <Plus className="size-4" /> Add entry
      </button>
    </section>
  );
}
