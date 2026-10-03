import type { ImageDescription } from "@openmanga/schemas";
import { ScanEye } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../../api/client.ts";
import { Field, Modal, Spinner, toast } from "../../../components/ui.tsx";
import { AiChip, useAiBody } from "../../ai/AiPicker.tsx";
import { withPose } from "./guide-draw.ts";

type JobDetail = { job: { status: string; failureReason: string | null; result: unknown } };

/**
 * "Describe pose": a vision job reads the layout guide's poses, placement and framing into one sentence, which is
 * shown for review and only written into the composition when the user says so, appended or replacing.
 */
export function DescribePose({
  panelId,
  composition,
  disabled,
  onApply,
}: {
  panelId: string;
  composition: string;
  disabled: boolean;
  onApply: (composition: string) => void;
}) {
  const aiText = useAiBody("text");
  const [busy, setBusy] = useState(false);
  const [pose, setPose] = useState<string | null>(null);
  const [mode, setMode] = useState<"append" | "replace">("append");

  const run = async () => {
    setBusy(true);
    try {
      const started = await post<{ job: { id: string } }>(`/panels/${panelId}/guide/describe`, aiText());
      const deadline = Date.now() + 5 * 60_000;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500));
        const d = await get<JobDetail>(`/generations/${started.job.id}`);
        if (d.job.status === "completed") {
          const p = (d.job.result as { description?: ImageDescription }).description?.pose;
          const text = p?.summary || [...(p?.figures ?? []), p?.framing].filter(Boolean).join("; ");
          if (!text) throw new Error("The model did not describe a pose");
          setMode(composition.trim() ? "append" : "replace");
          setPose(text);
          return;
        }
        // Paste mode: the job waits for an answer on its own page (the app already says where).
        if (d.job.status === "awaiting_input") return;
        if (["failed", "cancelled"].includes(d.job.status))
          throw new Error(d.job.failureReason ?? "The description did not finish");
        if (Date.now() > deadline) throw new Error("Still running: the result will be in Generation");
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          className="btn-secondary text-xs"
          disabled={disabled || busy}
          title="A vision model describes the sketch's poses, placement and framing; you review it before it is used"
          onClick={() => void run()}
        >
          {busy ? <Spinner /> : <ScanEye className="size-3.5" />} Describe pose
        </button>
        <AiChip cap="text" />
      </span>
      <Modal
        open={pose !== null}
        onClose={() => setPose(null)}
        title="Pose from the sketch"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setPose(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!pose?.trim()}
              onClick={() => {
                onApply(withPose(composition, pose ?? "", mode));
                setPose(null);
              }}
            >
              Write into composition
            </button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Field label="Description (edit it if needed)">
            <textarea className="input" rows={3} value={pose ?? ""} onChange={(e) => setPose(e.target.value)} />
          </Field>
          <fieldset className="space-y-1">
            <legend className="label">Composition field</legend>
            {(["append", "replace"] as const).map((m) => (
              <label key={m} className="flex items-center gap-2 text-xs">
                <input type="radio" name="pose-mode" checked={mode === m} onChange={() => setMode(m)} />
                {m === "append" ? "Add after what is there" : "Replace what is there"}
              </label>
            ))}
          </fieldset>
          <div>
            <div className="label">Composition after saving</div>
            <p className="rounded-lg bg-[var(--panel-2)] p-2 text-xs">{withPose(composition, pose ?? "", mode)}</p>
          </div>
        </div>
      </Modal>
    </>
  );
}
