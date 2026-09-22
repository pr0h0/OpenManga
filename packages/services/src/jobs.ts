import {
  and,
  audioJobs,
  type Database,
  type DbOrTx,
  eq,
  exportJobs,
  type GenerationKind,
  generationInputs,
  generationJobs,
  inArray,
  isNull,
  lt,
  outbox,
  sql,
} from "@openmanga/db";
import { hashOf } from "@openmanga/domain";
import { addToOutbox, type EventBus, type JobQueue, type OutboxDispatcher, type QueueName } from "@openmanga/queue";

export const QUEUE_FOR_KIND: Record<GenerationKind, QueueName> = {
  story_analysis: "text-ai",
  story_rewrite: "text-ai",
  chapter_plan: "text-ai",
  page_prompts: "text-ai",
  narration_text: "text-ai",
  character_reference: "image-generation",
  location_reference: "image-generation",
  prop_reference: "image-generation",
  style_reference: "image-generation",
  panel_generation: "image-generation",
  panel_edit: "image-edit",
  panel_check: "text-ai",
  image_describe: "text-ai",
  cover: "image-generation",
  image_batch_submit: "image-batch",
  text_batch_submit: "image-batch",
};

export type NewGenerationInput = {
  role: (typeof generationInputs.$inferInsert)["role"];
  assetId: string | null;
  variantId?: string | null;
  subjectVersionId?: string | null;
  label?: string;
  width?: number | null;
  height?: number | null;
  metadata?: Record<string, unknown>;
};

export type NewGenerationJob = {
  projectId: string;
  userId: string | null;
  kind: GenerationKind;
  priority: number;
  targetType?: string | null;
  targetId?: string | null;
  batchId?: string | null;
  templateName?: string | null;
  templateVersion?: number | null;
  compiledPrompt?: string | null;
  provider?: string | null;
  model?: string | null;
  parameters?: Record<string, unknown>;
  input?: Record<string, unknown>;
  inputs?: NewGenerationInput[];
  maxAttempts?: number;
};

/** Placeholder written while a retry is being created, so the claim is atomic. Replaced by the new job's id. */
const RETRY_CLAIMED = "00000000-0000-0000-0000-000000000000";

export class JobService {
  constructor(
    private readonly db: Database,
    private readonly opts: { queue?: JobQueue; dispatcher?: OutboxDispatcher; events?: EventBus } = {},
  ) {}

  /** Job row + inputs + outbox entry in ONE transaction. */
  /**
   * `opts.enqueue: false` writes the job and its inputs without an outbox row, so no worker picks it up. Used by
   * batch runs: the panels are collected into one provider submission by a single batch job, and running them
   * synchronously in the meantime is exactly what the caller is paying half price to avoid.
   */
  async createGenerationJob(tx: DbOrTx, j: NewGenerationJob, opts: { enqueue?: boolean } = {}) {
    const queue = QUEUE_FOR_KIND[j.kind];
    const inputs = j.inputs ?? [];
    const [job] = await tx
      .insert(generationJobs)
      .values({
        projectId: j.projectId,
        userId: j.userId,
        kind: j.kind,
        queue,
        priority: j.priority,
        batchId: j.batchId ?? null,
        targetType: j.targetType ?? null,
        targetId: j.targetId ?? null,
        templateName: j.templateName ?? null,
        templateVersion: j.templateVersion ?? null,
        compiledPrompt: j.compiledPrompt ?? null,
        promptHash: j.compiledPrompt ? hashOf(j.compiledPrompt) : null,
        referencesHash: inputs.length
          ? hashOf(inputs.map((i) => ({ role: i.role, assetId: i.assetId, variantId: i.variantId ?? null })))
          : null,
        optionsHash: hashOf({ provider: j.provider, model: j.model, parameters: j.parameters ?? {} }),
        provider: j.provider ?? null,
        model: j.model ?? null,
        parameters: j.parameters ?? {},
        input: j.input ?? {},
        maxAttempts: j.maxAttempts ?? 3,
      })
      .returning();
    if (inputs.length) {
      await tx.insert(generationInputs).values(
        inputs.map((i, order) => ({
          jobId: job!.id,
          role: i.role,
          order,
          assetId: i.assetId,
          variantId: i.variantId ?? null,
          subjectVersionId: i.subjectVersionId ?? null,
          label: i.label ?? "",
          width: i.width ?? null,
          height: i.height ?? null,
          metadata: i.metadata ?? {},
        })),
      );
    }
    if (opts.enqueue !== false)
      await addToOutbox(tx, {
        queue,
        jobName: j.kind,
        jobId: job!.id,
        payload: { jobId: job!.id, kind: j.kind },
        priority: j.priority,
      });
    return job!;
  }

  async createAudioJob(
    tx: DbOrTx,
    a: {
      projectId: string;
      userId: string | null;
      segmentId: string;
      voice: string;
      speed: number;
      batchId?: string | null;
      priority?: number;
      options?: Record<string, unknown>;
    },
  ) {
    const [job] = await tx
      .insert(audioJobs)
      .values({
        projectId: a.projectId,
        userId: a.userId,
        segmentId: a.segmentId,
        voice: a.voice,
        speed: a.speed,
        batchId: a.batchId ?? null,
        options: a.options ?? {},
      })
      .returning();
    await addToOutbox(tx, {
      queue: "tts",
      jobName: "tts",
      jobId: job!.id,
      payload: { audioJobId: job!.id },
      priority: a.priority ?? 5,
    });
    return job!;
  }

  async createExportJob(
    tx: DbOrTx,
    e: {
      projectId: string;
      userId: string | null;
      kind: (typeof exportJobs.$inferInsert)["kind"];
      chapterId?: string | null;
      options: Record<string, unknown>;
    },
  ) {
    const [job] = await tx
      .insert(exportJobs)
      .values({
        projectId: e.projectId,
        userId: e.userId,
        kind: e.kind,
        chapterId: e.chapterId ?? null,
        options: e.options,
      })
      .returning();
    await addToOutbox(tx, {
      queue: "export",
      jobName: e.kind,
      jobId: job!.id,
      payload: { exportJobId: job!.id },
      priority: 5,
    });
    return job!;
  }

  /**
   * Enqueues a job that was created with `enqueue: false` — the fallback when a batch run cannot be batched
   * after all (the key's provider has no batch API), so its panels run the ordinary way instead of waiting.
   */
  async enqueueGeneration(
    job: { id: string; queue: string; kind: GenerationKind; priority: number },
    /**
     * Overrides the queue's own dedupe key. The queue dedupes by job id, so a job that has already run once
     * cannot be handed back under the same key — the add is silently dropped. A job being resumed (a pasted
     * answer) passes something distinct per attempt, which still collapses an accidental double submit.
     */
    dedupeKey?: string,
  ) {
    await addToOutbox(this.db, {
      queue: job.queue as QueueName,
      jobName: job.kind,
      jobId: dedupeKey ?? job.id,
      payload: { jobId: job.id, kind: job.kind },
      priority: job.priority,
    });
  }

  /** Publish outbox promptly after commit; the worker loop is the safety net. */
  async kick() {
    await this.opts.dispatcher?.flush().catch(() => 0);
  }

  /**
   * Queued jobs are removed from Redis and cancelled. Running jobs are marked cancel_requested;
   * the worker discards/does not activate their output.
   */
  async cancelGeneration(jobId: string): Promise<"cancelled" | "cancel_requested" | "not_cancellable"> {
    const [job] = await this.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job) return "not_cancellable";
    if (job.status === "paused") {
      await this.db
        .update(generationJobs)
        .set({
          status: "cancelled",
          finishedAt: new Date(),
          cancelRequestedAt: new Date(),
          failureReason: "Cancelled while paused",
        })
        .where(eq(generationJobs.id, jobId));
      await this.opts.events?.publish(job.projectId, {
        type: "job.updated",
        jobId,
        kind: job.kind,
        status: "cancelled",
        targetType: job.targetType,
        targetId: job.targetId,
        batchId: job.batchId,
      });
      return "cancelled";
    }
    if (job.status === "queued") {
      const removed = this.opts.queue ? await this.opts.queue.removeWaiting(job.queue as QueueName, job.id) : true;
      if (removed) {
        await this.db
          .update(generationJobs)
          .set({
            status: "cancelled",
            finishedAt: new Date(),
            cancelRequestedAt: new Date(),
            failureReason: "Cancelled before start",
          })
          .where(eq(generationJobs.id, jobId));
        await this.opts.events?.publish(job.projectId, {
          type: "job.updated",
          jobId,
          kind: job.kind,
          status: "cancelled",
          targetType: job.targetType,
          targetId: job.targetId,
          batchId: job.batchId,
        });
        return "cancelled";
      }
    }
    // "submitted" included: the provider batch keeps running (it is already paid for), but the result is not
    // activated when it arrives — the ingest skips any job no longer in `submitted`.
    if (job.status === "queued" || job.status === "submitted" || job.status === "processing") {
      await this.db
        .update(generationJobs)
        .set({ status: "cancel_requested", cancelRequestedAt: new Date() })
        .where(eq(generationJobs.id, jobId));
      await this.opts.events?.publish(job.projectId, {
        type: "job.updated",
        jobId,
        kind: job.kind,
        status: "cancel_requested",
        targetType: job.targetType,
        targetId: job.targetId,
        batchId: job.batchId,
      });
      return "cancel_requested";
    }
    return "not_cancellable";
  }

  /**
   * Pause every not-yet-started job of a batch: removed from Redis and marked paused (reason kept in
   * failureReason). Running jobs finish normally. Returns the number paused.
   */
  async pauseBatch(batchId: string, reason: string) {
    const jobs = await this.db
      .select()
      .from(generationJobs)
      .where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.status, "queued")));
    let paused = 0;
    for (const job of jobs) {
      const removed = this.opts.queue ? await this.opts.queue.removeWaiting(job.queue as QueueName, job.id) : true;
      if (!removed) continue;
      const rows = await this.db
        .update(generationJobs)
        .set({ status: "paused", failureReason: `Paused: ${reason}` })
        .where(and(eq(generationJobs.id, job.id), eq(generationJobs.status, "queued")))
        .returning({ id: generationJobs.id });
      if (!rows.length) continue;
      paused++;
      await this.opts.events?.publish(job.projectId, {
        type: "job.updated",
        jobId: job.id,
        kind: job.kind,
        status: "paused",
        targetType: job.targetType,
        targetId: job.targetId,
        batchId: job.batchId,
        failureReason: `Paused: ${reason}`,
      });
    }
    return paused;
  }

  /** Re-queue paused jobs of a batch by re-arming their outbox rows (same job id, so no duplicates). */
  async resumeBatch(batchId: string, opts: { allowOverBudget?: boolean } = {}) {
    const rows = await this.db
      .update(generationJobs)
      .set({
        status: "queued",
        failureReason: null,
        failureCode: null,
        // A batch paused by the budget cap is resumed by someone who has just confirmed going over it, so the
        // confirmation is recorded on the jobs; otherwise the first one to run pauses the batch again.
        ...(opts.allowOverBudget
          ? { parameters: sql`${generationJobs.parameters} || '{"allowOverBudget":true}'::jsonb` }
          : {}),
      })
      .where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.status, "paused")))
      .returning();
    for (const job of rows) {
      // A batch-mode job must not be put back on its own queue: that runs it interactively, at twice the price
      // the caller chose to wait for. It goes back to waiting, and the batch submitter collects it again.
      if (job.parameters.batchMode !== true)
        await this.republish(job.queue as QueueName, job.id, job.kind, { jobId: job.id, kind: job.kind }, job.priority);
      await this.opts.events?.publish(job.projectId, {
        type: "job.updated",
        jobId: job.id,
        kind: job.kind,
        status: "queued",
        targetType: job.targetType,
        targetId: job.targetId,
        batchId: job.batchId,
      });
    }
    await this.kick();
    return rows.length;
  }

  private async republish(
    queue: QueueName,
    jobId: string,
    jobName: string,
    payload: Record<string, unknown>,
    priority: number,
  ) {
    const reset = await this.db
      .update(outbox)
      .set({ status: "pending", publishedAt: null })
      .where(and(eq(outbox.queue, queue), eq(outbox.jobId, jobId)))
      .returning({ id: outbox.id });
    if (!reset.length) await addToOutbox(this.db, { queue, jobName, jobId, payload, priority });
  }

  /**
   * Recover from Redis data loss (restore, FLUSHALL, eviction): queued jobs older than `graceMs` whose Redis job is
   * gone are re-published from the database. BullMQ dedupes by job id, so a job that still exists is never doubled.
   */
  async reconcileQueue(graceMs = 60_000) {
    if (!this.opts.queue) return { republished: 0 };
    const before = new Date(Date.now() - graceMs);
    let republished = 0;
    const gens = await this.db
      .select({
        id: generationJobs.id,
        kind: generationJobs.kind,
        queue: generationJobs.queue,
        priority: generationJobs.priority,
      })
      .from(generationJobs)
      .where(
        and(
          eq(generationJobs.status, "queued"),
          lt(generationJobs.createdAt, before),
          // A batch run's panels are deliberately not on a queue: they wait for one provider submission to
          // collect them. Republishing them here would run each one synchronously at full price.
          sql`coalesce(${generationJobs.parameters}->>'batchMode', 'false') <> 'true'`,
        ),
      );
    for (const j of gens) {
      if (await this.opts.queue.has(j.queue as QueueName, j.id)) continue;
      await this.republish(j.queue as QueueName, j.id, j.kind, { jobId: j.id, kind: j.kind }, j.priority);
      republished++;
    }
    const audios = await this.db
      .select({ id: audioJobs.id })
      .from(audioJobs)
      .where(and(eq(audioJobs.status, "queued"), lt(audioJobs.createdAt, before)));
    for (const j of audios) {
      if (await this.opts.queue.has("tts", j.id)) continue;
      await this.republish("tts", j.id, "tts", { audioJobId: j.id }, 5);
      republished++;
    }
    const exps = await this.db
      .select({ id: exportJobs.id, kind: exportJobs.kind })
      .from(exportJobs)
      .where(and(eq(exportJobs.status, "queued"), lt(exportJobs.createdAt, before)));
    for (const j of exps) {
      if (await this.opts.queue.has("export", j.id)) continue;
      await this.republish("export", j.id, j.kind, { exportJobId: j.id }, 5);
      republished++;
    }
    if (republished) await this.kick();
    return { republished };
  }

  /** Cancel a narration audio job that hasn't started. Running local synthesis can't be interrupted. */
  async cancelAudio(jobId: string): Promise<"cancelled" | "not_cancellable"> {
    const [job] = await this.db.select().from(audioJobs).where(eq(audioJobs.id, jobId));
    if (job?.status !== "queued") return "not_cancellable";
    const removed = this.opts.queue ? await this.opts.queue.removeWaiting("tts", job.id) : true;
    if (!removed) return "not_cancellable";
    const rows = await this.db
      .update(audioJobs)
      .set({ status: "cancelled", finishedAt: new Date(), failureReason: "Cancelled before start" })
      .where(and(eq(audioJobs.id, jobId), eq(audioJobs.status, "queued")))
      .returning({ id: audioJobs.id });
    if (!rows.length) return "not_cancellable";
    await this.opts.events?.publish(job.projectId, {
      type: "audio.updated",
      segmentId: job.segmentId,
      audioJobId: job.id,
      status: "cancelled",
    });
    return "cancelled";
  }

  /** Retry creates a NEW job (history preserved) with the same compiled prompt and inputs. */
  async retryGeneration(jobId: string, userId: string | null) {
    const [job] = await this.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    if (!job || !["failed", "cancelled"].includes(job.status)) return null;
    if (job.retriedByJobId) return null;
    // Claim the job before doing any work: reading the pointer and writing it afterwards is a check-then-set, so
    // two clicks on "retry all failed" could both pass the read and both pay for the same image.
    const claimed = await this.db
      .update(generationJobs)
      .set({ retriedByJobId: RETRY_CLAIMED })
      .where(and(eq(generationJobs.id, jobId), isNull(generationJobs.retriedByJobId)))
      .returning({ id: generationJobs.id });
    if (!claimed.length) return null;
    const inputs = await this.db
      .select()
      .from(generationInputs)
      .where(inArray(generationInputs.jobId, [jobId]));
    const created = await this.db.transaction((tx) =>
      this.createGenerationJob(tx, {
        projectId: job.projectId,
        userId,
        kind: job.kind,
        priority: job.priority,
        targetType: job.targetType,
        targetId: job.targetId,
        batchId: job.batchId,
        templateName: job.templateName,
        templateVersion: job.templateVersion,
        compiledPrompt: job.compiledPrompt,
        provider: job.provider,
        model: job.model,
        parameters: { ...job.parameters, retryOf: job.id },
        input: job.input,
        inputs: inputs
          .sort((a, b) => a.order - b.order)
          .map((i) => ({
            role: i.role,
            assetId: i.assetId,
            variantId: i.variantId,
            subjectVersionId: i.subjectVersionId,
            label: i.label,
            width: i.width,
            height: i.height,
            metadata: i.metadata,
          })),
      }),
    );
    // Replace the claim marker with the real replacement id.
    await this.db.update(generationJobs).set({ retriedByJobId: created.id }).where(eq(generationJobs.id, jobId));
    await this.kick();
    return created;
  }
}
