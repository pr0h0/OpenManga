import { trimSilenceWav } from "@openmanga/audio";
import { and, audioAssets, audioJobs, desc, eq, narrationLines, narrationSegments, projects, sql } from "@openmanga/db";
import { ProviderError } from "@openmanga/domain";
import { type Job, UnrecoverableError } from "@openmanga/queue";
import type { WorkerDeps } from "../context.ts";
import { userFacingError } from "../lib/runner.ts";

/**
 * Narration synthesis for one segment: local Kokoro by default, or the job's BYOK voice provider.
 * Reuses cached audio when provider/text/voice/speed are unchanged.
 */
export async function processTts(deps: WorkerDeps, bullJob: Job) {
  const id = String(bullJob.data.audioJobId);
  const [job] = await deps.db.select().from(audioJobs).where(eq(audioJobs.id, id));
  if (!job || job.status === "completed" || job.status === "cancelled") return;
  const publish = (status: string, failureReason?: string | null) =>
    deps.events.publish(job.projectId, {
      type: "audio.updated",
      segmentId: job.segmentId,
      audioJobId: id,
      status,
      failureReason,
    });
  let tts: Awaited<ReturnType<typeof deps.resolver.tts>>;
  try {
    tts = await deps.resolver.tts(
      (job.options.ai as { credentialId: string | null; model?: string } | undefined) ?? null,
      job.userId,
    );
  } catch (e) {
    const { code, message } = userFacingError(e);
    await deps.db
      .update(audioJobs)
      .set({ status: "failed", failureCode: code, failureReason: message, finishedAt: new Date() })
      .where(eq(audioJobs.id, id));
    await publish("failed", message);
    throw new UnrecoverableError(message);
  }
  if (!tts) {
    await deps.db
      .update(audioJobs)
      .set({
        status: "failed",
        failureCode: "disabled",
        failureReason: "Narration synthesis is disabled (TTS_ENABLED=false)",
        finishedAt: new Date(),
      })
      .where(eq(audioJobs.id, id));
    await publish("failed", "Narration synthesis is disabled");
    throw new UnrecoverableError("TTS disabled");
  }
  const [seg] = await deps.db
    .select({ s: narrationSegments, l: narrationLines })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .where(eq(narrationSegments.id, job.segmentId));
  if (!seg) {
    await deps.db
      .update(audioJobs)
      .set({
        status: "failed",
        failureCode: "invalid_input",
        failureReason: "Segment was deleted",
        finishedAt: new Date(),
      })
      .where(eq(audioJobs.id, id));
    return;
  }
  await deps.db
    .update(audioJobs)
    .set({ status: "processing", startedAt: new Date(), attempts: sql`${audioJobs.attempts} + 1` })
    .where(eq(audioJobs.id, id));
  await publish("processing");
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  const language = project?.language ?? "en";

  const [cached] = await deps.db
    .select()
    .from(audioAssets)
    .where(
      and(
        eq(audioAssets.projectId, job.projectId),
        eq(audioAssets.textSha256, seg.s.textSha256),
        eq(audioAssets.voice, job.voice),
        sql`abs(${audioAssets.speed} - ${job.speed}) < 0.001`,
        eq(audioAssets.provider, tts.provider),
      ),
    )
    .orderBy(desc(audioAssets.createdAt))
    .limit(1);
  // Audio synthesized before silence trimming carries the voice's padding; re-synthesize it instead of reusing it,
  // otherwise old segments keep the ~1s hole at every cut.
  const cachedAsset = cached ? await deps.assets.get(cached.assetId) : null;
  const cachedIsTrimmed =
    !deps.config.TTS_TRIM_SILENCE ||
    (cachedAsset?.metadata as { trimmedSilenceMs?: number } | null)?.trimmedSilenceMs !== undefined;
  if (cached && cachedAsset && cachedIsTrimmed) {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(narrationSegments)
        .set({ activeAudioAssetId: cached.assetId })
        .where(eq(narrationSegments.id, seg.s.id));
      await tx
        .update(audioJobs)
        .set({ status: "completed", audioAssetId: cached.assetId, reusedCache: true, finishedAt: new Date() })
        .where(eq(audioJobs.id, id));
    });
    await publish("completed");
    return { assetId: cached.assetId, reused: true };
  }

  try {
    const raw = await tts.synthesize({ text: seg.s.text, voice: job.voice, speed: job.speed, language });
    // Voices pad every segment with silence; trimming here keeps pauseAfterMs and the video breath honest.
    const trimmed = deps.config.TTS_TRIM_SILENCE
      ? trimSilenceWav(raw.wav, {
          thresholdDb: deps.config.TTS_TRIM_THRESHOLD_DB,
          keepMs: deps.config.TTS_TRIM_KEEP_MS,
        })
      : { wav: raw.wav, durationMs: raw.durationMs, trimmedMs: 0 };
    const r = { ...raw, wav: trimmed.wav, durationMs: trimmed.durationMs };
    if (trimmed.trimmedMs > 0)
      deps.logger.debug("trimmed silence", { segmentId: seg.s.id, trimmedMs: trimmed.trimmedMs });
    const asset = await deps.assets.store({
      projectId: job.projectId,
      ownerUserId: job.userId,
      type: "audio",
      data: r.wav,
      mimeType: "audio/wav",
      durationMs: r.durationMs,
      metadata: {
        segmentId: seg.s.id,
        voice: job.voice,
        speed: job.speed,
        sampleRate: r.sampleRate,
        provider: r.provider,
        modelVersion: r.modelVersion,
        textSha256: seg.s.textSha256,
        trimmedSilenceMs: trimmed.trimmedMs,
      },
    });
    // The line can be rewritten while this segment is being voiced (a narration re-run replaces its segments), so the
    // segment is locked and re-read before its audio is attached. Gone: the audio belongs to nothing, so it is dropped.
    const saved = await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ sha: narrationSegments.textSha256 })
        .from(narrationSegments)
        .where(eq(narrationSegments.id, seg.s.id))
        .for("update");
      if (!current) return false;
      await tx.insert(audioAssets).values({
        projectId: job.projectId,
        assetId: asset.id,
        segmentId: seg.s.id,
        textSha256: seg.s.textSha256,
        voice: job.voice,
        speed: job.speed,
        language,
        provider: r.provider,
        modelVersion: r.modelVersion,
        sampleRate: r.sampleRate,
        durationMs: r.durationMs,
        format: "wav",
      });
      if (current.sha === seg.s.textSha256)
        await tx
          .update(narrationSegments)
          .set({ activeAudioAssetId: asset.id })
          .where(eq(narrationSegments.id, seg.s.id));
      await tx
        .update(audioJobs)
        .set({
          status: "completed",
          audioAssetId: asset.id,
          finishedAt: new Date(),
          failureCode: null,
          failureReason: null,
        })
        .where(eq(audioJobs.id, id));
      return true;
    });
    if (!saved) {
      await deps.assets.hardDelete(asset).catch(() => {});
      await deps.db
        .update(audioJobs)
        .set({
          status: "failed",
          failureCode: "invalid_input",
          failureReason: "Segment was deleted",
          finishedAt: new Date(),
        })
        .where(eq(audioJobs.id, id));
      await publish("failed", "Segment was deleted");
      return;
    }
    await deps.usage.record({
      provider: r.provider,
      model: r.modelVersion ?? "kokoro-82m",
      operation: "tts",
      projectId: job.projectId,
      userId: job.userId,
      latencyMs: 0,
      characters: seg.s.text.length,
      metadata: { local: r.provider === "kokoro", durationMs: r.durationMs },
    });
    await publish("completed");
    return { assetId: asset.id, durationMs: r.durationMs };
  } catch (e) {
    const { code, message } = userFacingError(e);
    const retryable =
      e instanceof ProviderError && e.retryable && bullJob.attemptsMade + 1 < (bullJob.opts.attempts ?? 1);
    await deps.db
      .update(audioJobs)
      .set({
        status: retryable ? "queued" : "failed",
        failureCode: code,
        failureReason: retryable ? `${message} Retrying…` : message,
        finishedAt: retryable ? null : new Date(),
      })
      .where(eq(audioJobs.id, id));
    await publish(retryable ? "queued" : "failed", message);
    deps.logger.error("tts failed", {
      audioJobId: id,
      code,
      retryable,
      error: e instanceof Error ? e.message : String(e),
    });
    if (retryable) throw e;
    throw new UnrecoverableError(message);
  }
}
