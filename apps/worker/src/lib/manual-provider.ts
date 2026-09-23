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
 * A handler that asks several questions (planning: an outline, then each scene) parks once per question. Answers
 * are kept in order and replayed on every run, so each resume re-asks the answered questions, gets the stored
 * replies, and parks at the first one still open.
 *
 * The one deliberate difference from the batch replay is that the JSON-repair call is stripped. Repair exists to
 * ask the model again, and here there is no model to ask; `runStructured` reports the precise validation failure
 * instead, which is what the person needs to see so they can fix the answer and paste it again.
 */
import {
  type ChatMessage,
  formatPrompt,
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
  constructor(
    private readonly text: string,
    private readonly asked: (messages: ChatMessage[]) => void,
  ) {}
  async generateText(req: TextRequest): Promise<TextResult> {
    this.asked(req.messages);
    return { text: this.text, finishReason: "stop", call: manualCall() };
  }
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // No repair builder: there is no model to re-ask, so an invalid answer must surface its validation error
    // rather than triggering a second call that cannot happen.
    return runStructured(this, { ...req, buildRepairMessages: undefined });
  }
}

/**
 * Which call of the current run this is. A handler may ask several questions in one run — chapter planning asks
 * for an outline and then for each scene's pages — and every question gets its own answer, in order. Keyed on the
 * job object the runner handed to the handler, so the count lives exactly as long as one run: the next run reads
 * the row afresh, gets a new object, and starts again from the first call.
 */
const callIndex = new WeakMap<object, number>();

/**
 * The provider for one call of a keyless run. Answers already pasted are replayed in order — the handler is
 * deterministic, so the same run asks the same questions — and the first call without an answer parks the job
 * with that call's prompt.
 */
export function manualProvider(job: { id: string; parameters: Record<string, unknown> }): TextAIProvider {
  const n = callIndex.get(job) ?? 0;
  callIndex.set(job, n + 1);
  const answer = manualAnswers(job)[n];
  return answer !== undefined
    ? new PastedTextProvider(answer, (messages) => lastAsked.set(job, messages))
    : new CollectingManualProvider(job.id);
}

/**
 * The question the most recent replayed answer was given for. When that answer is rejected, this — not whatever
 * prompt an earlier, successful call left on the row — is what the person has to answer again. Showing the
 * earlier prompt instead sends them round a loop: they answer the question they were shown, and it is rejected
 * for not being the answer to the question that failed.
 */
const lastAsked = new WeakMap<object, ChatMessage[]>();
export const lastAskedPrompt = (job: object) => lastAsked.get(job);

/** Re-exported: the manual path is where the stored prompt text format matters most. */
export { formatPrompt };

/** Stored assets a prompt's images came from, so the manual view can offer them for download. */
export const promptAttachments = (messages: ChatMessage[]) =>
  messages.flatMap((m) => m.images ?? []).flatMap((i) => (i.assetId ? [i.assetId] : []));

/**
 * How many answers survive a rejection in this run: every answer before the call that failed. The failing call is
 * the last one this run made, so everything from it on is discarded — normally that is just the paste that was
 * rejected, but it stays right even if an earlier answer is the one that no longer fits.
 */
export const answersBeforeFailure = (job: object) => Math.max(0, (callIndex.get(job) ?? 1) - 1);

/** Answers pasted so far for this job, one per call, in the order the calls are made. */
export const manualAnswers = (job: { parameters: Record<string, unknown> }) =>
  Array.isArray(job.parameters.manualAnswers) ? (job.parameters.manualAnswers as string[]) : [];

/** Whether this job is a keyless run, decided once at enqueue time and stored on the job. */
export const isManual = (job: { parameters: Record<string, unknown> }) => job.parameters.manual === true;
