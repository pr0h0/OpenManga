import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Brush, Eye, RefreshCw, Sparkles, Wand2 } from "lucide-react";
import { useEffect, useState } from "react";
import { assetUrl, get, patch, post } from "../../../api/client.ts";
import { qk, useAction, useMeta } from "../../../api/hooks.ts";
import type { EditorPanel, PageDocument, PromptPreview } from "../../../api/types.ts";
import { ErrorBox, Field, KeyValue, Modal, Spinner, StatusChip } from "../../../components/ui.tsx";
import { AiChip, useAiBody } from "../../ai/AiPicker.tsx";
import { useProjectId } from "../../project/ProjectLayout.tsx";
import { MaskEditor } from "./MaskEditor.tsx";

const OPERATIONS = [
  ["change_expression", "Change expression"],
  ["change_pose", "Change pose"],
  ["change_camera", "Change camera"],
  ["change_background", "Change background"],
  ["change_outfit", "Change outfit"],
  ["remove_object", "Remove object"],
  ["add_object", "Add object"],
  ["reframe", "Reframe composition"],
] as const;

/** The picked image key as query params, so the preview reports the model this user's run would use. */
function previewQuery(body: ReturnType<ReturnType<typeof useAiBody>>) {
  const ai = (body as { ai?: { credentialId: string | null; model: string | null } }).ai;
  const p = new URLSearchParams();
  if (ai?.credentialId) p.set("credentialId", ai.credentialId);
  if (ai?.model) p.set("model", ai.model);
  return p.toString();
}

export function PromptInspector({ panelId, open, onClose }: { panelId: string; open: boolean; onClose: () => void }) {
  const { data: meta } = useMeta();
  const qs = previewQuery(useAiBody("image")());
  const q = useQuery({
    queryKey: ["prompt-preview", panelId, qs],
    queryFn: () => get<PromptPreview>(`/panels/${panelId}/prompt-preview${qs ? `?${qs}` : ""}`),
    enabled: open,
  });
  const d = q.data;
  return (
    <Modal open={open} onClose={onClose} title="Prompt inspector" wide="xl">
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} />
      {d && (
        <div className="grid gap-4 md:grid-cols-[1fr_18rem]">
          <div className="min-w-0">
            <div className="label">
              Compiled prompt {d.usesOverride && <StatusChip status="prompt-ready" label="user-edited override" />}
            </div>
            <pre className="max-h-[55vh] overflow-auto rounded-lg bg-[var(--panel-2)] p-3 text-xs whitespace-pre-wrap">
              {d.compiledPrompt}
            </pre>
          </div>
          <div className="space-y-3 text-sm">
            <KeyValue
              items={[
                ["Template", `${d.template.name} v${d.template.version}`],
                ["Model", [d.provider, d.model].filter(Boolean).join(" · ") || "no key selected"],
                ["Quality", d.quality],
                ["Aspect ratio", `${d.aspectRatio.toFixed(2)} : 1`],
                [
                  "Characters",
                  d.characters
                    .map((c) => `${c.name} v${c.versionNumber}${c.hasReference ? "" : " (no approved ref)"}`)
                    .join(", ") || "none",
                ],
              ]}
            />
            <div>
              <div className="label">Reference images ({d.references.length})</div>
              <p className="muted mb-2 text-xs">
                Canonical references stay full resolution. Requests send small cached derivatives (≈
                {meta?.referenceDefaults.maxWidth ?? 192}×{meta?.referenceDefaults.maxHeight ?? 288}, fit{" "}
                {meta?.referenceDefaults.fit ?? "inside"}).
              </p>
              <ul className="space-y-2">
                {d.references.map((r) => (
                  <li key={`${r.index}-${r.assetId}`} className="flex items-center gap-2">
                    <img
                      src={assetUrl(r.assetId, "thumbnail")}
                      alt={r.label}
                      className="size-12 rounded object-cover"
                    />
                    <div className="min-w-0 text-xs">
                      <div className="font-medium">
                        #{r.index} {r.label}
                      </div>
                      <div className="muted">
                        {r.role.replace("_", " ")} · canonical {r.canonicalWidth}×{r.canonicalHeight}
                      </div>
                    </div>
                  </li>
                ))}
                {!d.references.length && <li className="muted text-xs">No approved references apply to this panel.</li>}
              </ul>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

export function PromptTab({ data, panel }: { data: PageDocument; panel: EditorPanel }) {
  const projectId = useProjectId();
  const [override, setOverride] = useState(panel.promptOverride ?? "");
  const [op, setOp] = useState<(typeof OPERATIONS)[number][0]>("change_expression");
  const [instruction, setInstruction] = useState("");
  const [inspect, setInspect] = useState(false);
  const [masking, setMasking] = useState(false);
  useEffect(() => setOverride(panel.promptOverride ?? ""), [panel.id, panel.promptOverride]);
  const inv = [qk.page(data.page.id), qk.panel(panel.id), qk.generations(projectId), ["prompt-preview", panel.id]];
  const locked = panel.approvalStatus === "locked";
  const busy = panel.status === "queued" || panel.status === "generating";

  const saveOverride = useAction((v: string | null) => patch(`/panels/${panel.id}`, { promptOverride: v }), {
    invalidate: inv,
    success: "Prompt saved",
  });
  const aiImage = useAiBody("image");
  const aiText = useAiBody("text");
  const generate = useAction(
    (body: Record<string, unknown>) => post(`/panels/${panel.id}/generate`, { ...aiImage(), ...body }),
    {
      invalidate: inv,
      success: "Generation queued",
    },
  );
  const prepare = useAction(() => post(`/pages/${data.page.id}/prepare-prompts`, aiText()), {
    invalidate: [qk.generations(projectId)],
    success: "Prompt preparation queued for this page",
  });
  const loadCompiled = async () => {
    const p = await get<PromptPreview>(`/panels/${panel.id}/prompt-preview`);
    setOverride(p.generatedPrompt);
  };

  return (
    <div className="space-y-4 text-sm">
      {panel.latestJob && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-2 text-xs">
          <div className="min-w-0">
            <StatusChip status={panel.latestJob.status} />{" "}
            <span className="muted">{panel.latestJob.kind.replace("_", " ")}</span>
            {panel.latestJob.failureReason && <div className="mt-1 text-red-500">{panel.latestJob.failureReason}</div>}
          </div>
          <Link
            to="/projects/$projectId/generation/$jobId"
            params={{ projectId, jobId: panel.latestJob.id }}
            className="btn-ghost text-xs"
          >
            Inspect
          </Link>
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-1">
        <AiChip cap="image" />
        <AiChip cap="text" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={locked || busy || generate.isPending}
          onClick={() => generate.mutate({ operation: "same_prompt" })}
        >
          <Sparkles className="size-4" /> {panel.artwork ? "Regenerate" : "Generate"}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setInspect(true)}>
          <Eye className="size-4" /> Inspect prompt
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={!panel.artwork || locked || busy}
          onClick={() => setMasking(true)}
        >
          <Brush className="size-4" /> Masked edit
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={prepare.isPending}
          onClick={() => prepare.mutate()}
          title="The text model writes descriptive prompt sections for every panel on this page"
        >
          <Wand2 className="size-4" /> Prepare page prompts
        </button>
      </div>

      <div className="space-y-2 rounded-lg border border-[var(--border)] p-2">
        <div className="label">Regenerate with a change</div>
        <select
          className="input"
          aria-label="Change type"
          value={op}
          onChange={(e) => setOp(e.target.value as typeof op)}
        >
          {OPERATIONS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <input
          className="input"
          aria-label="Change instruction"
          placeholder="e.g. make him look furious"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
        />
        <button
          type="button"
          className="btn-secondary w-full"
          disabled={!instruction.trim() || locked || busy}
          onClick={() => generate.mutate({ operation: op, instruction }, { onSuccess: () => setInstruction("") })}
        >
          <RefreshCw className="size-4" /> Regenerate with change
        </button>
      </div>

      <Field
        label="Prompt override (used instead of the compiled prompt)"
        hint={
          panel.promptOverride
            ? "An override is active for this panel."
            : "Empty = compiled automatically from structured panel state."
        }
      >
        <textarea
          className="input font-mono text-xs"
          rows={10}
          value={override}
          onChange={(e) => setOverride(e.target.value)}
          disabled={locked}
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={() => void loadCompiled()} disabled={locked}>
          Load compiled prompt
        </button>
        <button
          type="button"
          className="btn-secondary"
          disabled={locked || saveOverride.isPending}
          onClick={() => saveOverride.mutate(override.trim() ? override : null)}
        >
          Save
        </button>
        <button
          type="button"
          className="btn-ghost"
          disabled={locked || !panel.promptOverride}
          onClick={() => {
            setOverride("");
            saveOverride.mutate(null);
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="btn-primary ml-auto"
          disabled={!override.trim() || locked || busy}
          onClick={() => generate.mutate({ operation: "edited_prompt", promptOverride: override })}
        >
          Regenerate with edited prompt
        </button>
      </div>
      <PromptInspector panelId={panel.id} open={inspect} onClose={() => setInspect(false)} />
      {masking && panel.artwork && (
        <MaskEditor
          panelId={panel.id}
          artworkId={panel.artwork.id}
          pageId={data.page.id}
          onClose={() => setMasking(false)}
        />
      )}
    </div>
  );
}
