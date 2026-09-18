/**
 * Batching every text job without rewriting any of them.
 *
 * Each text handler gathers its context, builds messages, and calls one funnel (`generateStructured`). So rather
 * than splitting six handlers into build and apply halves, the *provider* is swapped:
 *
 *   - Submit pass: `CollectingTextProvider` records the request and throws `ParkedForBatch`. The submit job runs
 *     each sibling handler purely to harvest its messages, then submits them together.
 *   - Ingest pass: `ReplayTextProvider` answers the first call with the text the batch returned, so the handler
 *     runs to completion — validation, appliers, events and usage accounting all unchanged. A second call (the
 *     structured-output repair, when a batched answer is not valid JSON) goes to the live API, because waiting
 *     another 24h for a repair would be absurd; that one call bills at the interactive rate.
 */
import {
  batchCallRecord,
  type ChatMessage,
  runStructured,
  type StructuredRequest,
  type StructuredResult,
  type TextAIProvider,
  type TextBatchRequestSpec,
  type TextCallRecord,
  type TextRequest,
  type TextResult,
} from "@openmanga/ai-text";
import { batchModel } from "@openmanga/domain";

/** Thrown once a job's request has been collected; the submit job catches it and moves on. */
export class ParkedForBatch extends Error {
  constructor(readonly jobId: string) {
    super("Request collected for a provider batch");
    this.name = "ParkedForBatch";
  }
}

export class BatchCollector {
  readonly specs: TextBatchRequestSpec[] = [];
  push(spec: TextBatchRequestSpec) {
    this.specs.push(spec);
  }
}

class CollectingTextProvider implements TextAIProvider {
  constructor(
    private readonly real: TextAIProvider,
    private readonly collector: BatchCollector,
    private readonly jobId: string,
  ) {}
  get provider() {
    return this.real.provider;
  }
  get model() {
    return this.real.model;
  }
  async generateText(req: TextRequest): Promise<TextResult> {
    this.collector.push({
      key: this.jobId,
      messages: req.messages,
      maxTokens: req.maxTokens,
      temperature: req.temperature,
      json: req.json ?? true,
    });
    throw new ParkedForBatch(this.jobId);
  }
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }
}

class ReplayTextProvider implements TextAIProvider {
  private used = false;
  constructor(
    private readonly real: TextAIProvider,
    private readonly text: string,
    private readonly call: TextCallRecord,
  ) {}
  get provider() {
    return this.real.provider;
  }
  get model() {
    return this.real.model;
  }
  async generateText(req: TextRequest): Promise<TextResult> {
    if (this.used) return this.real.generateText(req);
    this.used = true;
    return { text: this.text, finishReason: "stop", call: this.call };
  }
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }
}

export type BatchedAnswer = {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
};

/**
 * Wraps a text provider for a job in batch mode. `collector` set means the submit pass; a stored answer on the
 * job means the ingest pass; neither means an ordinary synchronous run.
 */
export function batchAware(
  real: TextAIProvider,
  job: { id: string; parameters: Record<string, unknown> },
  collector?: BatchCollector,
): TextAIProvider {
  if (collector) return new CollectingTextProvider(real, collector, job.id);
  const answer = job.parameters.batchAnswer as BatchedAnswer | undefined;
  if (!answer?.text) return real;
  // The batch billed once, but a handler that retries replays the same answer — so the tokens are reported only
  // on the first run, or a job that fails validation twice would charge the project two or three times over.
  const alreadyRecorded = job.parameters.batchUsageRecorded === true;
  const usage = alreadyRecorded ? { inputTokens: 0, outputTokens: 0, cachedTokens: 0 } : answer.usage;
  // Recorded against the ":batch" model, so the run is charged the discounted rate it was actually billed.
  return new ReplayTextProvider(
    real,
    answer.text,
    batchCallRecord(real.provider, batchModel(real.model), usage, { batch: true, replayed: alreadyRecorded }),
  );
}

/** Messages a collected spec carries, for logging without dumping image bytes. */
export const describeMessages = (messages: ChatMessage[]) =>
  messages.map((m) => `${m.role}:${m.content.length}c${m.images?.length ? `+${m.images.length}img` : ""}`).join(" ");
