/**
 * The timing pass: once narration is voiced, its real lengths (not words-per-minute estimates) show where a chapter's
 * pacing is off, and what to change. Pure, over the same shared timeline as the preview and the render (`timeShots`),
 * so what it reports is what the video will do.
 */

import { type TimedLine, timeShots, VIDEO_BREATH_MS } from "./video.ts";

export type TimingSettings = {
  /** The export's minimum hold (the shots' floor unless a shot sets its own). */
  minHoldMs: number;
  fps: number;
  /** The shortest and longest a shot should hold (the project's target runtime, else 4 and 8 s). */
  minShotMs: number;
  maxShotMs: number;
  /** A single picture on screen longer than this reads as a still. */
  stillMs: number;
  /** A gap in the narration (or a silent tail) longer than this reads as dead air. */
  silenceMs: number;
};

export const timingSettings = (
  runtime: { minShotSeconds: number; maxShotSeconds: number } | null | undefined,
  minHoldMs?: number,
): TimingSettings => ({
  minHoldMs: minHoldMs ?? (runtime ? runtime.minShotSeconds * 1000 : 2500),
  fps: 30,
  minShotMs: (runtime?.minShotSeconds ?? 4) * 1000,
  maxShotMs: (runtime?.maxShotSeconds ?? 8) * 1000,
  stillMs: 12_000,
  silenceMs: 3_000,
});

export type TimingLine = TimedLine & { id: string; text: string };
export type TimingShot = {
  key: string;
  label: string;
  panelId: string | null;
  sceneId: string | null;
  joinNext: boolean;
  /** The shot's own minimum hold (`ShotVideo.holdMs`). */
  minHoldMs: number | null;
  lines: TimingLine[];
};

export type TimingIssue = {
  kind: "long" | "flash" | "still" | "silence";
  key: string;
  label: string;
  /** The hold, or the silence's length. */
  ms: number;
  message: string;
};

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Holds and starts of every shot, and what made each group as long as it is. */
const time = (shots: TimingShot[], s: TimingSettings) => timeShots(shots, { minHoldMs: s.minHoldMs, fps: s.fps });

/**
 * What is off in a chapter's pacing: shots that hold past the longest-shot setting or flash by under the shortest, a
 * single picture held past `stillMs`, and dead air — a gap between narration segments, or a silent tail after the
 * narration, longer than `silenceMs`. Each shot carries its hold and its own narration's length.
 */
export function timingIssues(shots: TimingShot[], s: TimingSettings) {
  const film = time(shots, s);
  const issues: TimingIssue[] = [];
  const add = (i: number, kind: TimingIssue["kind"], ms: number, message: string) =>
    issues.push({ kind, key: shots[i]!.key, label: shots[i]!.label, ms, message });
  film.shots.forEach((t, i) => {
    if (t.holdMs > s.stillMs) add(i, "still", t.holdMs, `One picture for ${sec(t.holdMs)}`);
    else if (t.holdMs > s.maxShotMs) add(i, "long", t.holdMs, `Holds ${sec(t.holdMs)}, past ${sec(s.maxShotMs)}`);
    else if (t.holdMs < s.minShotMs) add(i, "flash", t.holdMs, `Only ${sec(t.holdMs)}, under ${sec(s.minShotMs)}`);
  });
  for (const g of film.groups) {
    const lines = shots.slice(g.first, g.last + 1).flatMap((x) => x.lines);
    // Gaps between consecutive voiced segments: pauses and offsets.
    let end: number | null = null;
    lines.forEach((l, k) => {
      l.segments.forEach((seg, j) => {
        const start = g.starts[k]![j]!;
        if (end !== null && start - end > s.silenceMs)
          add(g.first, "silence", start - end, `${sec(start - end)} of silence inside the narration`);
        end = start + seg.ms;
      });
    });
    const tail = g.holdMs - g.narrationMs - (g.voiced ? VIDEO_BREATH_MS : 0);
    if (g.voiced && tail > s.silenceMs)
      add(g.last, "silence", tail, `${sec(tail)} of silence after the narration (held for the minimum)`);
  }
  return { film, issues };
}

/** A fix, with the holds it changes before and after and the chapter's change in length. */
type Effect = { holds: { key: string; beforeMs: number; afterMs: number }[]; deltaMs: number };

const effect = (shots: TimingShot[], next: TimingShot[], s: TimingSettings): Effect => {
  const a = time(shots, s);
  const b = time(next, s);
  return {
    holds: a.shots
      .map((t, i) => ({ key: shots[i]!.key, beforeMs: Math.round(t.holdMs), afterMs: Math.round(b.shots[i]!.holdMs) }))
      .filter((h) => h.beforeMs !== h.afterMs || next[shots.findIndex((x) => x.key === h.key)]!.joinNext),
    deltaMs: Math.round(b.totalMs - a.totalMs),
  };
};

export type SpreadFix = Effect & { lineId: string; fromKey: string; untilPanelId: string; shots: number };
export type HoldFix = Effect & { panelId: string; key: string; holdMs: number; reason: string };
export type TrimFix = { lineId: string; text: string; words: number; budget: number };

/**
 * What the timing pass offers to change, each previewed with its effect on the holds and the chapter's length:
 *
 * - spread: a shot held long by its own narration shares its longest line with the next shots of the same scene
 *   (the line's `untilPanelId`), so one picture is not on screen for the whole line. Existing art only.
 * - holds: a shot's own minimum hold, within the min/max settings where its narration allows: a flash held to the
 *   shortest-shot length, a shot padded past its narration held only as long as the narration needs.
 * - trim: when the chapter misses its target length by more than a tenth, each voiced line with the word budget that
 *   would land it on target (rewritten by a text job, then re-voiced, only for the lines the user picks).
 */
export function timingFixes(shots: TimingShot[], s: TimingSettings, targetMs: number | null) {
  const { film } = timingIssues(shots, s);
  const spread: SpreadFix[] = [];
  const holds: HoldFix[] = [];
  for (const g of film.groups) {
    if (g.first !== g.last) continue;
    const i = g.first;
    const shot = shots[i]!;
    const need = g.narrationMs + VIDEO_BREATH_MS;
    const hold = film.shots[i]!.holdMs;
    // Spread: narration-bound past the longest shot, and silent-of-its-own neighbours in the same scene follow.
    if (need > s.maxShotMs && shot.lines.length && !shots[i - 1]?.joinNext) {
      const want = Math.ceil(need / s.maxShotMs) - 1;
      const take: number[] = [];
      for (let j = i + 1; j < shots.length && take.length < want; j++) {
        const n = shots[j]!;
        if (n.sceneId !== shot.sceneId || n.joinNext || shots[j - 1]!.joinNext || !n.panelId) break;
        take.push(j);
      }
      const last = take.at(-1);
      if (last !== undefined) {
        const line = [...shot.lines].sort(
          (a, b) => b.segments.reduce((n, x) => n + x.ms, 0) - a.segments.reduce((n, x) => n + x.ms, 0),
        )[0]!;
        const next = shots.map((x, k) => (k >= i && k < last ? { ...x, joinNext: true } : x));
        spread.push({
          lineId: line.id,
          fromKey: shot.key,
          untilPanelId: shots[last]!.panelId!,
          shots: take.length + 1,
          ...effect(shots, next, s),
        });
      }
    }
    if (!shot.panelId) continue;
    // Holds: never below the narration, within the min/max settings.
    const floor = g.voiced ? need : 0;
    let target: number | null = null;
    let reason = "";
    // The hold the settings ask for, never below what the narration needs (a long line is for `spread`).
    const ideal = Math.ceil(
      Math.max(floor, Math.ceil(Math.min(s.maxShotMs, Math.max(s.minShotMs, floor)) / 100) * 100),
    );
    if (hold < s.minShotMs) {
      target = s.minShotMs;
      reason = `held to the shortest-shot length, ${sec(s.minShotMs)}`;
    } else if ((hold > s.maxShotMs || (g.voiced && hold - need > s.silenceMs)) && ideal < hold) {
      target = ideal;
      reason = g.voiced
        ? "held only as long as its narration"
        : `a shot without narration, held to the longest-shot length, ${sec(s.maxShotMs)}`;
    }
    if (target !== null && Math.abs(target - hold) >= 1000 / s.fps) {
      const next = shots.map((x, k) => (k === i ? { ...x, minHoldMs: target } : x));
      holds.push({ panelId: shot.panelId, key: shot.key, holdMs: target, reason, ...effect(shots, next, s) });
    }
  }
  const trim: TrimFix[] = [];
  if (targetMs && Math.abs(film.totalMs - targetMs) > targetMs * 0.1) {
    const factor = Math.min(1.5, Math.max(0.5, targetMs / film.totalMs));
    for (const x of shots)
      for (const l of x.lines) {
        const text = l.text.trim();
        const n = words(text);
        const budget = Math.max(3, Math.round(n * factor));
        if (n && Math.abs(budget - n) >= 2) trim.push({ lineId: l.id, text, words: n, budget });
      }
  }
  return { spread, holds, trim };
}
