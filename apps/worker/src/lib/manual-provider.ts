/**
 * Running a text job with no provider key at all: the person is the provider.
 *
 * This is the same trick the batch path uses — swap the provider, leave every handler alone — with the two passes
 * driven by a human instead of a provider's batch API:
 *
 *   - Collect pass: `CollectingManualProvider` records the messages the handler built and throws
 *     `ParkedForManualInput`. The runner parks the job as `awaiting_input` with that prompt stored, ready to be
 *     copied into whatever chat the user has.
 *   - Replay pass: `PastedTextProvider` answers with the text they pasted back, so the handler runs to
 *     completion — schema validation, appliers, events, all of it unchanged. That is the whole point: a pasted
 *     answer is held to exactly the standard an API answer is.
 *
 * The one deliberate difference from the batch replay is that the JSON-repair call is stripped. Repair exists to
 * ask the model again, and here there is no model to ask; `runStructured` reports the precise validation failure
 * instead, which is what the person needs to see so they can fix the answer and paste it again.
 */
import {
  type ChatMessage,
  runStructured,
  type StructuredRequest,
  type StructuredResult,
  type TextAIProvider,
  type TextCallRecord,
  type TextRequest,
  type TextResult,
} from "@openmanga/ai-text";

/** Thrown once a manual job's prompt has been built; the runner catches it and parks the job. */
export class ParkedForManualInput extends Error {
  constructor(
    readonly jobId: string,
    readonly messages: ChatMessage[],
  ) {
    super("Prompt compiled and waiting for a pasted answer");
    this.name = "ParkedForManualInput";
  }
}

export const MANUAL_PROVIDER = "manual";

/** Nothing was spent, so nothing is billed: a manual run records a call with zero tokens. */
const manualCall = (): TextCallRecord => ({
  provider: MANUAL_PROVIDER,
  model: MANUAL_PROVIDER,
  requestId: null,
  purpose: "primary",
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  latencyMs: 0,
  rawUsage: { manual: true },
  success: true,
});

class CollectingManualProvider implements TextAIProvider {
  readonly provider = MANUAL_PROVIDER;
  readonly model = MANUAL_PROVIDER;
  constructor(private readonly jobId: string) {}
  async generateText(req: TextRequest): Promise<TextResult> {
    throw new ParkedForManualInput(this.jobId, req.messages);
  }
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }
}

class PastedTextProvider implements TextAIProvider {
  readonly provider = MANUAL_PROVIDER;
  readonly model = MANUAL_PROVIDER;
  private used = false;
  constructor(private readonly text: string) {}
  async generateText(): Promise<TextResult> {
    // Only the first call can be answered: there is no second source of text here, and a handler asking twice
    // would otherwise silently receive the same answer to a different question.
    if (this.used) throw new ParkedForManualInput("", []);
    this.used = true;
    return { text: this.text, finishReason: "stop", call: manualCall() };
  }
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // No repair builder: there is no model to re-ask, so an invalid answer must surface its validation error
    // rather than triggering a second call that cannot happen.
    return runStructured(this, { ...req, buildRepairMessages: undefined });
  }
}

/** The provider for a keyless run: collects the prompt, or replays what the user pasted. */
export function manualProvider(job: { id: string; parameters: Record<string, unknown> }): TextAIProvider {
  const answer = job.parameters.manualAnswer as { text?: string } | undefined;
  return answer?.text ? new PastedTextProvider(answer.text) : new CollectingManualProvider(job.id);
}

/** Whether this job is a keyless run, decided once at enqueue time and stored on the job. */
export const isManual = (job: { parameters: Record<string, unknown> }) => job.parameters.manual === true;
