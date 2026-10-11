import {
  and,
  asc,
  chapters,
  type Database,
  eq,
  inArray,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projects,
  type Tx,
} from "@openmanga/db";
import {
  NarrationLineVideo,
  type ProjectSettings,
  ShotVideo,
  type VideoCard,
  type VideoEditOp,
} from "@openmanga/schemas";

type Project = { id: string };
type Video = NonNullable<ProjectSettings["video"]>;

/** What one edit changes: a line for the review list, how many things move, and the write that does it. */
export type ResolvedEdit = {
  label: string;
  effect: string;
  changes: number;
  write: (tx: Tx) => Promise<void>;
};

const sec = (ms: number) => `${(Math.abs(ms) / 1000).toFixed(1)} s`;

/**
 * Work out the rows one timeline edit changes, from the project as it is now. The proposal's review list and the
 * apply share it, so what is applied is what the list said, recomputed against any edits made since. A chapter or
 * panel outside the project is an error.
 */
export async function resolveVideoEdit(db: Database, project: Project, op: VideoEditOp): Promise<ResolvedEdit> {
  const chapterRows = await db
    .select({ id: chapters.id, order: chapters.order })
    .from(chapters)
    .where(eq(chapters.projectId, project.id))
    .orderBy(asc(chapters.order));
  if (!chapterRows.length) throw new Error("This project has no chapters yet");
  const orderOf = new Map(chapterRows.map((c) => [c.id, c.order]));
  const scopeId = "chapterId" in op ? op.chapterId : null;
  if (scopeId && !orderOf.has(scopeId)) throw new Error("That chapter is not in this project");
  const where = scopeId ? `Chapter ${orderOf.get(scopeId)}` : "Whole video";

  switch (op.op) {
    case "pauses": {
      const next = (ms: number) => {
        let v = op.pauseScale != null ? Math.round(ms * op.pauseScale) : ms;
        if (op.maxPauseMs != null) v = Math.min(v, op.maxPauseMs);
        return v;
      };
      const segs = await db
        .select({ id: narrationSegments.id, ms: narrationSegments.pauseAfterMs })
        .from(narrationSegments)
        .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
        .where(
          and(
            eq(narrationSegments.projectId, project.id),
            scopeId ? eq(narrationLines.chapterId, scopeId) : inArray(narrationLines.chapterId, [...orderOf.keys()]),
          ),
        );
      const lines = await db
        .select({ id: narrationLines.id, video: narrationLines.video })
        .from(narrationLines)
        .where(
          scopeId ? eq(narrationLines.chapterId, scopeId) : inArray(narrationLines.chapterId, [...orderOf.keys()]),
        );
      const segChanges = segs.filter((s) => next(s.ms) !== s.ms).map((s) => ({ id: s.id, ms: next(s.ms), was: s.ms }));
      const lineChanges = lines.flatMap((l) => {
        if (!l.video) return [];
        const v = NarrationLineVideo.parse(l.video);
        const after = { ...v, startOffsetMs: next(v.startOffsetMs), endOffsetMs: next(v.endOffsetMs) };
        const saved = v.startOffsetMs + v.endOffsetMs - after.startOffsetMs - after.endOffsetMs;
        return saved ? [{ id: l.id, video: after, saved }] : [];
      });
      const saved = segChanges.reduce((n, s) => n + s.was - s.ms, 0) + lineChanges.reduce((n, l) => n + l.saved, 0);
      const how = [
        op.pauseScale != null ? `×${op.pauseScale}` : "",
        op.maxPauseMs != null ? `at most ${op.maxPauseMs} ms` : "",
      ]
        .filter(Boolean)
        .join(", ");
      return {
        label: `${where}: pauses ${how || "unchanged"}`,
        effect: `${segChanges.length + lineChanges.length} pauses, ${sec(saved)} ${saved >= 0 ? "shorter" : "longer"}`,
        changes: segChanges.length + lineChanges.length,
        write: async (tx) => {
          for (const s of segChanges)
            await tx.update(narrationSegments).set({ pauseAfterMs: s.ms }).where(eq(narrationSegments.id, s.id));
          for (const l of lineChanges)
            await tx.update(narrationLines).set({ video: l.video }).where(eq(narrationLines.id, l.id));
        },
      };
    }
    case "holds": {
      const rows = await db
        .select({ id: panels.id, video: panels.video })
        .from(panels)
        .innerJoin(pages, eq(pages.id, panels.pageId))
        .where(and(eq(panels.projectId, project.id), scopeId ? eq(pages.chapterId, scopeId) : undefined));
      const changed = rows.filter((r) => (r.video?.holdMs ?? null) !== op.holdMs);
      return {
        label: `${where}: each shot's minimum hold ${op.holdMs == null ? "back to the export's" : sec(op.holdMs)}`,
        effect: `${changed.length} shots`,
        changes: changed.length,
        write: async (tx) => {
          for (const r of changed)
            await tx
              .update(panels)
              .set({ video: { ...ShotVideo.parse(r.video ?? {}), holdMs: op.holdMs } })
              .where(eq(panels.id, r.id));
        },
      };
    }
    case "shot": {
      const [row] = await db
        .select({
          id: panels.id,
          video: panels.video,
          order: panels.order,
          pageOrder: pages.order,
          ch: pages.chapterId,
        })
        .from(panels)
        .innerJoin(pages, eq(pages.id, panels.pageId))
        .where(and(eq(panels.id, op.panelId), eq(panels.projectId, project.id)));
      if (!row) throw new Error("That panel is not in this project");
      const cur = ShotVideo.parse(row.video ?? {});
      const after = {
        ...cur,
        ...(op.disabled !== undefined ? { disabled: op.disabled } : {}),
        ...(op.motion ? { motion: op.motion } : {}),
        ...(op.fade ? { fade: op.fade } : {}),
      };
      const what = [
        op.disabled !== undefined ? (op.disabled ? "left out" : "played") : "",
        op.motion ? `motion ${op.motion}` : "",
        op.fade ? `fade ${op.fade}` : "",
      ].filter(Boolean);
      const changes = JSON.stringify(after) === JSON.stringify(cur) ? 0 : 1;
      return {
        label: `Chapter ${orderOf.get(row.ch)}, page ${row.pageOrder}, panel ${row.order}: ${what.join(", ") || "unchanged"}`,
        effect: changes ? "1 shot" : "already so",
        changes,
        write: async (tx) => {
          if (changes) await tx.update(panels).set({ video: after }).where(eq(panels.id, row.id));
        },
      };
    }
    case "card": {
      if (op.which === "chapter" && !scopeId) throw new Error("A chapter card needs its chapter");
      const name = op.which === "chapter" ? `${where} title card` : op.which === "intro" ? "Intro card" : "Outro card";
      return settingsEdit(
        db,
        project,
        op.card ? `${name}: “${op.card.title}”${op.card.subtitle ? ` / ${op.card.subtitle}` : ""}` : `${name}: off`,
        (v) => {
          if (op.which !== "chapter") return { ...v, [op.which]: op.card };
          const rest = (v.chapterCards ?? []).filter((c) => c.chapterId !== scopeId);
          return { ...v, chapterCards: op.card ? [...rest, { ...op.card, chapterId: scopeId! }] : rest };
        },
      );
    }
    case "scene_fades":
      return settingsEdit(db, project, `Fade to black at scene breaks: ${op.on ? "on" : "off"}`, (v) => ({
        ...v,
        fadeAtSceneBreaks: op.on,
      }));
  }
}

/** A change to the project's video settings, re-read inside the write so several in one apply build on each other. */
async function settingsEdit(
  db: Database,
  project: Project,
  label: string,
  change: (v: Video) => Video,
): Promise<ResolvedEdit> {
  const [p] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, project.id));
  const before: Video = { fadeAtSceneBreaks: false, ...p!.settings.video };
  const changes = JSON.stringify(change(before)) === JSON.stringify(before) ? 0 : 1;
  return {
    label,
    effect: changes ? "video settings" : "already so",
    changes,
    write: async (tx) => {
      const [cur] = await tx.select({ settings: projects.settings }).from(projects).where(eq(projects.id, project.id));
      const video = change({ fadeAtSceneBreaks: false, ...cur!.settings.video });
      await tx
        .update(projects)
        .set({ settings: { ...cur!.settings, video }, updatedAt: new Date() })
        .where(eq(projects.id, project.id));
    },
  };
}

/** Apply reviewed edits in one transaction, in order; returns what each did. */
export async function applyVideoEdits(db: Database, project: Project, ops: VideoEditOp[]) {
  const resolved: ResolvedEdit[] = [];
  for (const op of ops) resolved.push(await resolveVideoEdit(db, project, op));
  await db.transaction(async (tx) => {
    for (const r of resolved) await r.write(tx);
  });
  return resolved.map(({ label, effect, changes }) => ({ label, effect, changes }));
}

/** A card as the model describes it: title, subtitle and seconds; null when the title is (removing it). */
export function cardOf(title: string | null, subtitle: string | null, seconds: number | null): VideoCard | null {
  if (title == null) return null;
  return { title, subtitle: subtitle ?? "", durationMs: Math.round((seconds ?? 3) * 1000) };
}
