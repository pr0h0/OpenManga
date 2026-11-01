import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseWav, pauseMs, pcmToWav, quietestMs } from "@openmanga/audio";
import { sql } from "@openmanga/db";
import { alignSegments, type SpokenWord } from "@openmanga/domain";
import { attachImportedTake } from "@openmanga/services";
import { withTempDir } from "@openmanga/storage";
import type { WorkerDeps } from "../context.ts";
import { InputError, isCancelRequested, JobCancelledError, type ProjectJob } from "../lib/runner.ts";
import { run } from "../lib/video.ts";

const SAMPLE_RATE = 24_000;

/** Reads the recogniser's NDJSON answer: the timed words, the recording's length and the language it heard. */
async function transcribe(deps: WorkerDeps, job: ProjectJob, path: string, language: string) {
  const base = deps.config.WHISPER_URL.replace(/\/$/, "");
  if (!base) throw new InputError("Speech recognition is not set up on this server (WHISPER_URL is empty)");
  const abort = new AbortController();
  let res: Response;
  try {
    res = await fetch(`${base}/transcribe?language=${encodeURIComponent(language)}`, {
      method: "POST",
      body: Bun.file(path),
      headers: { "content-type": "application/octet-stream" },
      signal: abort.signal,
      // The answer streams for as long as the transcription runs (about half the recording's length).
      timeout: false,
    } as RequestInit);
  } catch (e) {
    throw new InputError(
      `Speech recognition is not reachable at ${base} (start the whisper service: compose profile "stt"): ${String(e)}`,
    );
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new InputError(`Speech recognition refused the recording (${res.status}): ${detail.slice(0, 300)}`);
  }
  const words: SpokenWord[] = [];
  let durationS = 0;
  let heard = language;
  let done = false;
  let buffered = "";
  let lines = 0;
  const decoder = new TextDecoder();
  const onLine = (line: string) => {
    if (!line.trim()) return;
    const m = JSON.parse(line) as {
      error?: string;
      done?: boolean;
      duration?: number;
      language?: string;
      words?: [number, number, string][];
    };
    if (m.error) throw new InputError(`Speech recognition failed: ${m.error}`);
    if (m.done) done = true;
    if (m.duration !== undefined) durationS = m.duration;
    if (m.language) heard = m.language;
    for (const [start, end, word] of m.words ?? []) words.push({ start, end, word });
  };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true });
      let nl = buffered.indexOf("\n");
      while (nl >= 0) {
        onLine(buffered.slice(0, nl));
        buffered = buffered.slice(nl + 1);
        nl = buffered.indexOf("\n");
        if (++lines % 25 === 0 && (await isCancelRequested(deps, job.id))) {
          abort.abort();
          throw new JobCancelledError();
        }
      }
    }
    onLine(buffered);
  } catch (e) {
    if (e instanceof InputError || e instanceof JobCancelledError) throw e;
    throw new InputError(`Speech recognition stopped before the end of the recording: ${String(e)}`);
  }
  if (!done) throw new InputError("Speech recognition stopped before the end of the recording");
  return { words, durationMs: Math.round(durationS * 1000), language: heard };
}

/**
 * Narration recorded outside OpenManga, cut into the segments it reads: the recording is transcribed with word timings
 * (local Whisper), the words are matched to the segments of the chosen chapters in order, and each segment found gets
 * the stretch between the pauses around it as its take. Segments not found keep the audio they had.
 */
export async function narrationImport(deps: WorkerDeps, job: ProjectJob) {
  const uploadPath = String(job.input.uploadPath ?? "");
  const language = String(job.input.language);
  const chapterIds = Array.isArray(job.input.chapterIds) ? (job.input.chapterIds as string[]) : null;
  try {
    if (
      !uploadPath.startsWith(join(deps.config.TEMP_ROOT, "narration-imports")) ||
      !(await Bun.file(uploadPath).exists())
    )
      throw new InputError("The uploaded recording is gone; upload it again");
    const segments = [
      ...(await deps.db.execute<{ id: string; text: string; text_sha256: string; chapter_id: string }>(sql`
        select s.id, s.text, s.text_sha256, nl.chapter_id
        from narration_segments s
        join narration_lines nl on nl.id = s.narration_line_id
        join chapters ch on ch.id = nl.chapter_id
        where nl.project_id = ${job.projectId} and nl.language = ${language}
          ${
            chapterIds
              ? sql`and nl.chapter_id in (${sql.join(
                  chapterIds.map((id) => sql`${id}`),
                  sql`, `,
                )})`
              : sql``
          }
        order by ch."order", nl."order", s."order"`)),
    ];
    if (!segments.length) throw new InputError("There is no narration text to match the recording to");

    return await withTempDir(deps.config.TEMP_ROOT, async (dir) => {
      // The whole recording as 16-bit mono at the narration's rate, in memory: what every take is cut from.
      // ponytail: ~170 MB per hour of audio held at once; stream it through the cut loop if hours-long imports matter.
      const wavPath = join(dir, "recording.wav");
      await run(
        [
          "ffmpeg",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          uploadPath,
          "-ac",
          "1",
          "-ar",
          String(SAMPLE_RATE),
          "-c:a",
          "pcm_s16le",
          wavPath,
        ],
        "Decoding the recording",
      ).catch((e) => {
        throw new InputError(`The file could not be read as audio: ${String(e).slice(0, 300)}`);
      });
      const wav = await Bun.file(wavPath).bytes();
      const info = parseWav(wav);
      const pcm = new Int16Array(wav.buffer, wav.byteOffset + info.dataOffset, Math.floor(info.dataLength / 2));

      const heard = await transcribe(deps, job, uploadPath, language);
      if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
      const spans = alignSegments(segments, heard.words, info.durationMs);

      let attached = 0;
      const missed: { segmentId: string; chapterId: string; text: string; matched: number; words: number }[] = [];
      for (const [k, span] of spans.entries()) {
        const seg = segments[k]!;
        // Half its words heard, at least: fewer and the span is a guess, so the segment keeps the audio it had.
        if (
          !span.cutBefore ||
          !span.cutAfter ||
          !span.nearBefore ||
          !span.nearAfter ||
          span.matched < Math.max(1, Math.ceil(span.words / 2))
        ) {
          missed.push({
            segmentId: seg.id,
            chapterId: seg.chapter_id,
            text: seg.text.slice(0, 200),
            matched: span.matched,
            words: span.words,
          });
          continue;
        }
        if (k % 50 === 0 && (await isCancelRequested(deps, job.id))) throw new JobCancelledError();
        // In a pause when there is one; lines run together are cut at the quietest spot next to the word boundary.
        const startMs =
          pauseMs(pcm, SAMPLE_RATE, ...span.cutBefore, "last") ?? quietestMs(pcm, SAMPLE_RATE, ...span.nearBefore);
        const endMs =
          pauseMs(pcm, SAMPLE_RATE, ...span.cutAfter, "first") ?? quietestMs(pcm, SAMPLE_RATE, ...span.nearAfter);
        const from = Math.round((startMs / 1000) * SAMPLE_RATE);
        const to = Math.round((endMs / 1000) * SAMPLE_RATE);
        const cut = pcmToWav(
          new Uint8Array(pcm.buffer, pcm.byteOffset + from * 2, Math.max(0, to - from) * 2),
          SAMPLE_RATE,
        );
        const saved = await attachImportedTake(deps.db, deps.assets, {
          projectId: job.projectId,
          userId: job.userId,
          segmentId: seg.id,
          textSha256: seg.text_sha256,
          language,
          wav: cut,
          trim: { thresholdDb: deps.config.TTS_TRIM_THRESHOLD_DB, keepMs: deps.config.TTS_TRIM_KEEP_MS },
          generationJobId: job.id,
          metadata: {
            sourceName: job.input.originalName ?? null,
            sourceStartMs: Math.round((from / SAMPLE_RATE) * 1000),
            sourceEndMs: Math.round((to / SAMPLE_RATE) * 1000),
            matchedWords: span.matched,
            words: span.words,
          },
        });
        if (saved) attached++;
      }
      for (const chapterId of new Set(segments.map((s) => s.chapter_id)))
        await deps.events.publish(job.projectId, { type: "narration.updated", chapterId });
      return {
        segments: segments.length,
        attached,
        missed: missed.slice(0, 200),
        missedCount: missed.length,
        recordingMs: info.durationMs,
        heardWords: heard.words.length,
        heardLanguage: heard.language,
      };
    });
  } finally {
    // One attempt only (the route queues it so): the upload is not needed again whatever the outcome.
    await rm(uploadPath, { force: true }).catch(() => {});
  }
}
