import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { toast } from "../../components/ui.tsx";

export const KIND_LABELS: Record<string, string> = {
  story_analysis: "Story analysis",
  story_rewrite: "Story rewrite",
  chapter_plan: "Chapter planning",
  page_prompts: "Prompt prep",
  narration_text: "Narration text",
  character_reference: "Character ref",
  location_reference: "Location ref",
  prop_reference: "Prop ref",
  style_reference: "Style ref",
  panel_generation: "Panel",
  panel_edit: "Panel edit",
  cover: "Cover",
};

export const JOB_STATUSES = [
  "queued",
  "awaiting_input",
  "processing",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
] as const;

export const kindLabel = (k: string) => KIND_LABELS[k] ?? k.replace(/_/g, " ");

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch (e) {
          toast.error(e);
        }
      }}
    >
      {done ? <Check className="size-4" /> : <Copy className="size-4" />} {done ? "Copied" : label}
    </button>
  );
}

export function JsonBlock({ value, maxHeight = "20rem" }: { value: unknown; maxHeight?: string }) {
  return (
    <pre
      className="overflow-auto rounded-lg bg-[var(--panel-2)] p-3 font-mono text-xs leading-relaxed"
      style={{ maxHeight }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ProgressBar({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? "Progress"}
      className="h-2 w-full overflow-hidden rounded-full bg-[var(--panel-2)]"
    >
      <div className="h-full bg-accent-500 transition-all" style={{ width: `${pct}%` }} />
    </div>
  );
}
