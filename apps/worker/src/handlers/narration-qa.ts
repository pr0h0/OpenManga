import { open } from "node:fs/promises";
import { join } from "node:path";
import { type AudioStats, analyseWav, ffmpegConvert, parseWav, pcmToWav } from "@openmanga/audio";
import { and, eq, inArray, narrationFindings, sql } from "@openmanga/db";
import { audioFindings, type LintFinding, languageName, loudnessFindings, splitSentences } from "@openmanga/domain";
import { narrationFixV1, narrationLintV1 } from "@openmanga/prompts";
import { NarrationFix, NarrationLintReport } from "@openmanga/schemas";
import { type LintComparison, loadNarrationQa, type QaChapter, saveFindings } from "@openmanga/services";
import { withTempDir } from "@openmanga/storage";
import type { WorkerDeps } from "../context.ts";
import { InputError, type ProjectJob } from "../lib/runner.ts";
import { run } from "../lib/video.ts";
import { structured } from "./text.ts";

/** Lines are named L1, L2, … in the prompts: short for the model, and mapped back to ids here. */
const keyed = (c: QaChapter) => c.lines.map((l, i) => ({ key: `L${i + 1}`, line: l }));

/** Earlier chapters' narration budget in the lint prompt, nearest chapters first. */
const EARLIER_CHARS = 30_000;

async function chapterOf(deps: WorkerDeps, job: ProjectJob) {
  const language = String(job.input.language);
  const all = await loadNarrationQa(deps.db, job.projectId, language);
  const chapter = all.find((c) => c.id === String(job.input.chapterId));
  if (!chapter) throw new InputError("Chapter no longer exists");
  if (!chapter.lines.length) throw new InputError("The chapter has no narration to check");
  return { all, chapter, language };
}

/**
 * Semantic narration lint for one chapter: meaning repeated in other words (here and against earlier chapters),
 * facts explained again, and lines that only describe their frame. Earlier chapters go in as their summary and the
 * first sentence of each line, so a long project stays within context.
 */
export async function narrationLint(deps: WorkerDeps, job: ProjectJob) {
  const { all, chapter, language } = await chapterOf(deps, job);
  const shots = new Map(chapter.shots.map((s) => [s.id, s]));
  const lines = keyed(chapter);
  const earlier: { order: number; title: string; summary: string; narration: string[] }[] = [];
  let budget = EARLIER_CHARS;
  // ponytail: earlier chapters shortened to first sentences and cut off at a character budget, nearest first; a
  // very long project's first chapters drop out of view. Chunking them into several calls if that ever matters.
  for (const c of all.filter((o) => o.order < chapter.order && o.lines.length).reverse()) {
    const entry = {
      order: c.order,
      title: c.title,
      summary: c.summary.slice(0, 400),
      narration: c.lines.map((l) => (splitSentences(l.text)[0] ?? l.text).slice(0, 160)),
    };
    budget -= JSON.stringify(entry).length;
    if (budget < 0) break;
    earlier.unshift(entry);
  }
  const r = await structured(
    deps,
    job,
    narrationLintV1.build({
      chapter: { order: chapter.order, title: chapter.title, summary: chapter.summary },
      lines: lines.map(({ key, line }) => {
        const shot = line.panelId ? shots.get(line.panelId) : undefined;
        return {
          key,
          text: line.text,
          frame: shot?.frame || undefined,
          dialogue: shot?.dialogue.length ? shot.dialogue : undefined,
        };
      }),
      earlierChapters: earlier,
    }),
    NarrationLintReport,
    "NarrationLintReport",
    16_000,
  );
  const byKey = new Map(lines.map(({ key, line }) => [key, line.id]));
  const byOrder = new Map(all.map((c) => [c.order, c.id]));
  // Keys the answer made up are dropped; a finding left with no line is no finding.
  const findings: LintFinding[] = r.data.findings.flatMap((f) => {
    const lineIds = [
      ...new Set(f.lines.map((k) => byKey.get(k.trim().toUpperCase())).filter((x): x is string => Boolean(x))),
    ];
    if (!lineIds.length) return [];
    return [
      {
        kind: f.type,
        severity: f.severity,
        lineIds,
        relatedChapterIds: f.relatedChapters
          .map((n) => byOrder.get(n))
          .filter((x): x is string => Boolean(x) && x !== chapter.id),
        message: f.explanation,
      },
    ];
  });
  const comparison = await saveFindings(deps.db, {
    projectId: job.projectId,
    chapterId: chapter.id,
    language,
    source: "ai",
    findings,
  });
  await deps.events.publish(job.projectId, { type: "narration.updated", chapterId: chapter.id });
  return { chapterId: chapter.id, language, repaired: r.repaired, ...comparison };
}

/**
 * Proposes rewrites of the lines the chosen findings flag, and nothing else. The answer is checked against the
 * flagged lines and returned as before/after pairs: nothing is written until the user applies it.
 */
export async function narrationFix(deps: WorkerDeps, job: ProjectJob) {
  const { chapter, language } = await chapterOf(deps, job);
  const ids = Array.isArray(job.input.findingIds) ? (job.input.findingIds as string[]) : [];
  const findings = ids.length
    ? await deps.db
        .select()
        .from(narrationFindings)
        .where(and(inArray(narrationFindings.id, ids), eq(narrationFindings.chapterId, chapter.id)))
    : [];
  if (!findings.length) throw new InputError("None of the chosen findings is still open on this chapter");
  const lines = keyed(chapter);
  const keyOf = new Map(lines.map(({ key, line }) => [line.id, key]));
  const flagged = new Set(findings.flatMap((f) => f.lineIds.map((id) => keyOf.get(id)).filter(Boolean)));
  if (!flagged.size) throw new InputError("The flagged lines no longer exist");
  const shots = new Map(chapter.shots.map((s) => [s.id, s]));
  const r = await structured(
    deps,
    job,
    narrationFixV1.build({
      language: `${languageName(language)} (${language})`,
      findings: findings.map((f) => ({
        lines: f.lineIds.map((id) => keyOf.get(id)).filter((k): k is string => Boolean(k)),
        problem: `${f.kind.replaceAll("_", " ")}: ${f.message}`,
      })),
      lines: lines.map(({ key, line }) => {
        const shot = flagged.has(key) && line.panelId ? shots.get(line.panelId) : undefined;
        return {
          key,
          text: line.text,
          frame: shot?.frame || undefined,
          dialogue: shot?.dialogue.length ? shot.dialogue : undefined,
        };
      }),
    }),
    NarrationFix,
    "NarrationFix",
    16_000,
  );
  const byKey = new Map(lines.map(({ key, line }) => [key, line]));
  const proposals = r.data.lines.flatMap((p) => {
    const key = p.line.trim().toUpperCase();
    const line = byKey.get(key);
    // Only flagged lines may change, each once; an unchanged "rewrite" is no proposal.
    if (!line || !flagged.has(key) || line.text.trim() === p.text.trim()) return [];
    flagged.delete(key);
    return [{ lineId: line.id, key, before: line.text, after: p.text.trim() }];
  });
  return { chapterId: chapter.id, language, findingIds: findings.map((f) => f.id), proposals, repaired: r.repaired };
}

const SAMPLE_RATE = 24_000;

/** Integrated loudness, loudness range and true peak of a WAV file, from ffmpeg's EBU R128 meter. */
async function ebur128(path: string) {
  const { stderr } = await run(
    ["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "ebur128=peak=true", "-f", "null", "-"],
    "loudness meter",
  );
  const summary = stderr.slice(stderr.lastIndexOf("Summary:"));
  const num = (re: RegExp) => Number(summary.match(re)?.[1] ?? Number.NaN);
  return {
    lufs: num(/I:\s+(-?[\d.]+) LUFS/),
    lra: num(/LRA:\s+(-?[\d.]+) LU/),
    truePeakDb: num(/Peak:\s+(-?[\d.]+) dBFS/),
  };
}

/**
 * The audio check of some chapters (all voiced ones when none are named): every current segment's audio is measured
 * for silence, clipping, stalls and level, and each chapter's narration, joined with its pauses, through the EBU R128
 * meter for its loudness and true peak. No model, nothing spent; findings are stored like the other narration checks.
 */
export async function audioCheck(deps: WorkerDeps, job: ProjectJob) {
  const language = String(job.input.language);
  const only = Array.isArray(job.input.chapterIds) ? (job.input.chapterIds as string[]) : null;
  const rows = await deps.db.execute<{
    chapter_id: string;
    line_id: string;
    pause_after_ms: number;
    asset_id: string;
  }>(sql`
    select nl.chapter_id, nl.id as line_id, s.pause_after_ms, s.active_audio_asset_id as asset_id
    from narration_segments s
    join narration_lines nl on nl.id = s.narration_line_id
    join chapters ch on ch.id = nl.chapter_id
    join audio_assets a on a.asset_id = s.active_audio_asset_id and a.text_sha256 = s.text_sha256
    where nl.project_id = ${job.projectId} and nl.language = ${language}
    order by ch."order", nl."order", s."order"`);
  const byChapter = new Map<string, (typeof rows)[number][]>();
  for (const r of rows)
    if (!only || only.includes(r.chapter_id)) byChapter.set(r.chapter_id, [...(byChapter.get(r.chapter_id) ?? []), r]);
  if (!byChapter.size) throw new InputError("No voiced narration to check: voice the chapters first");
  const chapters: {
    chapterId: string;
    segments: number;
    missing: number;
    lufs: number;
    lra: number;
    truePeakDb: number;
    findings: LintFinding[];
  }[] = [];
  await withTempDir(deps.config.TEMP_ROOT, async (dir) => {
    for (const [chapterId, segs] of byChapter) {
      // The chapter as the film plays it: segments in order with their pauses, one WAV on disk for the meter.
      const path = join(dir, `${chapterId}.wav`);
      const file = await open(path, "w");
      let bytes = 0;
      const append = async (data: Uint8Array) => {
        await file.write(data, 0, data.length, 44 + bytes);
        bytes += data.length;
      };
      const measured: { lineId: string; stats: AudioStats }[] = [];
      let missing = 0;
      try {
        for (const seg of segs) {
          const asset = await deps.assets.get(seg.asset_id);
          if (!asset) {
            missing++;
            continue;
          }
          let wav = await deps.assets.read(asset);
          let info = parseWav(wav);
          if (info.sampleRate !== SAMPLE_RATE || info.channels !== 1 || info.bitsPerSample !== 16) {
            wav = await ffmpegConvert(wav, "wav", { tempDir: dir });
            info = parseWav(wav);
          }
          measured.push({ lineId: seg.line_id, stats: analyseWav(wav) });
          await append(wav.subarray(info.dataOffset, info.dataOffset + info.dataLength));
          await append(new Uint8Array(Math.round((seg.pause_after_ms / 1000) * SAMPLE_RATE) * 2));
        }
        const header = pcmToWav(new Uint8Array(0), SAMPLE_RATE);
        const hv = new DataView(header.buffer);
        hv.setUint32(4, 36 + bytes, true);
        hv.setUint32(40, bytes, true);
        await file.write(header, 0, 44, 0);
      } finally {
        await file.close();
      }
      const loud = measured.length
        ? await ebur128(path)
        : { lufs: Number.NaN, lra: Number.NaN, truePeakDb: Number.NaN };
      chapters.push({ chapterId, segments: segs.length, missing, ...loud, findings: audioFindings(measured) });
    }
  });
  // Chapter loudness is compared across the chapters checked together.
  const loudness = loudnessFindings(chapters.map((c) => ({ id: c.chapterId, lufs: c.lufs })));
  const report: (LintComparison & { chapterId: string; [k: string]: unknown })[] = [];
  for (const c of chapters) {
    const findings = [...c.findings, ...(loudness.has(c.chapterId) ? [loudness.get(c.chapterId)!] : [])];
    const comparison = await saveFindings(deps.db, {
      projectId: job.projectId,
      chapterId: c.chapterId,
      language,
      source: "audio",
      findings,
    });
    await deps.events.publish(job.projectId, { type: "narration.updated", chapterId: c.chapterId });
    const round = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
    report.push({
      chapterId: c.chapterId,
      segments: c.segments,
      missingAudio: c.missing,
      lufs: round(c.lufs),
      lra: round(c.lra),
      truePeakDb: round(c.truePeakDb),
      ...comparison,
    });
  }
  const sum = (k: "found" | "introduced" | "remaining" | "resolved") => report.reduce((n, r) => n + r[k], 0);
  return {
    language,
    chapters: report,
    found: sum("found"),
    introduced: sum("introduced"),
    remaining: sum("remaining"),
    resolved: sum("resolved"),
  };
}
