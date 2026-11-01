import { trimSilenceWav } from "@openmanga/audio";
import { audioAssets, type Database, eq, narrationSegments } from "@openmanga/db";
import { IMPORTED_AUDIO_PROVIDER } from "@openmanga/domain";
import type { AssetService } from "./assets.ts";

/** The voice an imported take shows: imported takes are current while their text is, whatever voice the project names. */
export const IMPORTED_VOICE = "imported";

/**
 * Stores a take cut from (or uploaded as) a recording made elsewhere and makes it the segment's audio. `wav` is 16-bit
 * mono PCM; it is trimmed like a synthesized take so the segment's pause is the only gap after it. The segment's text
 * is re-read under a lock: rewritten or deleted since `textSha256` was read, the take speaks other words and is
 * dropped (returns null).
 */
export async function attachImportedTake(
  db: Database,
  assets: AssetService,
  t: {
    projectId: string;
    userId: string | null;
    segmentId: string;
    textSha256: string;
    language: string;
    wav: Uint8Array;
    trim: { thresholdDb: number; keepMs: number };
    generationJobId?: string;
    metadata?: Record<string, unknown>;
  },
) {
  const take = trimSilenceWav(t.wav, t.trim);
  const asset = await assets.store({
    projectId: t.projectId,
    ownerUserId: t.userId,
    type: "audio",
    data: take.wav,
    mimeType: "audio/wav",
    durationMs: take.durationMs,
    generationJobId: t.generationJobId,
    metadata: {
      ...t.metadata,
      segmentId: t.segmentId,
      provider: IMPORTED_AUDIO_PROVIDER,
      textSha256: t.textSha256,
      trimmedSilenceMs: take.trimmedMs,
    },
  });
  const saved = await db.transaction(async (tx) => {
    const [current] = await tx
      .select({ sha: narrationSegments.textSha256 })
      .from(narrationSegments)
      .where(eq(narrationSegments.id, t.segmentId))
      .for("update");
    if (current?.sha !== t.textSha256) return false;
    await tx.insert(audioAssets).values({
      projectId: t.projectId,
      assetId: asset.id,
      segmentId: t.segmentId,
      textSha256: t.textSha256,
      voice: IMPORTED_VOICE,
      speed: 1,
      language: t.language,
      provider: IMPORTED_AUDIO_PROVIDER,
      modelVersion: null,
      sampleRate: 24_000,
      durationMs: take.durationMs,
      format: "wav",
    });
    await tx
      .update(narrationSegments)
      .set({ activeAudioAssetId: asset.id })
      .where(eq(narrationSegments.id, t.segmentId));
    return true;
  });
  if (saved) return { assetId: asset.id, durationMs: take.durationMs };
  await assets.hardDelete(asset).catch(() => {});
  return null;
}
