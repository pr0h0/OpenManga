import { type Database, type ExportKind, sql } from "@openmanga/db";

export type ReadinessIssue = {
  code:
    | "missing_artwork"
    | "no_narration"
    | "narration_gaps"
    | "missing_audio"
    | "superseded_versions"
    | "draft_versions";
  area: "art" | "narration";
  /** "block" issues gate exports until acknowledged; "info" is reported but never blocks. */
  severity: "block" | "info";
  chapterId: string | null;
  chapterLabel: string | null;
  count: number;
  message: string;
};

export type ChapterReadiness = {
  id: string;
  order: number;
  title: string;
  pages: number;
  panels: number;
  panelsWithoutArt: number;
  narrationLines: number;
  narratedPanels: number;
  segments: number;
  segmentsWithoutAudio: number;
  supersededPins: number;
  draftVersionPins: number;
};

export type Readiness = {
  language: string;
  chapters: ChapterReadiness[];
  issues: ReadinessIssue[];
  ready: { art: boolean; narration: boolean };
};

/** Export kinds and the readiness areas they depend on. */
export const EXPORT_AREAS: Record<Exclude<ExportKind, "project_import">, ("art" | "narration")[]> = {
  png_pages: ["art"],
  jpg_pages: ["art"],
  pdf: ["art"],
  cbz: ["art"],
  epub: ["art"],
  webtoon: ["art"],
  zip_package: ["art"],
  project_json: [],
  narration_audio: ["narration"],
  timeline: ["narration"],
  agent_package: ["art", "narration"],
  video_pages: ["art", "narration"],
  video_panels: ["art", "narration"],
};

/**
 * What an export would silently ship incomplete: panels without artwork, chapters without (or with patchy)
 * narration, segments without audio, and panels pinned to superseded or still-draft character/location versions.
 */
export async function projectReadiness(
  db: Database,
  projectId: string,
  opts: { chapterId?: string | null; language?: string | null } = {},
): Promise<Readiness> {
  const [proj] = await db.execute<{ language: string }>(sql`select language from projects where id = ${projectId}`);
  const language = opts.language || proj?.language || "en";
  const rows = await db.execute<ChapterReadiness>(sql`
    select ch.id, ch."order", ch.title,
      (select count(*)::int from pages pg where pg.chapter_id = ch.id) as pages,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = ch.id) as panels,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id
        where pg.chapter_id = ch.id and pn.active_artwork_asset_id is null) as "panelsWithoutArt",
      (select count(*)::int from narration_lines nl where nl.chapter_id = ch.id and nl.language = ${language}) as "narrationLines",
      (select count(distinct nl.panel_id)::int from narration_lines nl
        where nl.chapter_id = ch.id and nl.language = ${language} and nl.panel_id is not null) as "narratedPanels",
      (select count(*)::int from narration_segments s join narration_lines nl on nl.id = s.narration_line_id
        where nl.chapter_id = ch.id and nl.language = ${language}) as segments,
      (select count(*)::int from narration_segments s join narration_lines nl on nl.id = s.narration_line_id
        where nl.chapter_id = ch.id and nl.language = ${language} and s.active_audio_asset_id is null) as "segmentsWithoutAudio",
      (select count(distinct pn.id)::int from panels pn join pages pg on pg.id = pn.page_id
        cross join lateral jsonb_array_elements_text(pn.character_version_ids) as cv(id)
        join character_versions v on v.id = cv.id::uuid
        where pg.chapter_id = ch.id and v.status = 'superseded') as "supersededPins",
      (select count(distinct pn.id)::int from panels pn join pages pg on pg.id = pn.page_id
        left join location_versions lv on lv.id = pn.location_version_id
        where pg.chapter_id = ch.id and (lv.status = 'draft' or exists (
          select 1 from jsonb_array_elements_text(pn.character_version_ids) as cv(id)
          join character_versions v on v.id = cv.id::uuid where v.status = 'draft'))) as "draftVersionPins"
    from chapters ch
    where ch.project_id = ${projectId} ${opts.chapterId ? sql`and ch.id = ${opts.chapterId}` : sql``}
    order by ch."order"`);
  const chapters = [...rows];
  const issues: ReadinessIssue[] = [];
  for (const ch of chapters) {
    const label = `Ch. ${ch.order} — ${ch.title}`;
    const add = (code: ReadinessIssue["code"], area: ReadinessIssue["area"], count: number, message: string) =>
      issues.push({
        code,
        area,
        severity: code === "draft_versions" ? "info" : "block",
        chapterId: ch.id,
        chapterLabel: label,
        count,
        message,
      });
    if (ch.panelsWithoutArt)
      add(
        "missing_artwork",
        "art",
        ch.panelsWithoutArt,
        `${ch.panelsWithoutArt} of ${ch.panels} panels have no artwork (pages would render blank frames)`,
      );
    if (ch.supersededPins)
      add(
        "superseded_versions",
        "art",
        ch.supersededPins,
        `${ch.supersededPins} panels use a superseded character version`,
      );
    if (ch.draftVersionPins)
      add(
        "draft_versions",
        "art",
        ch.draftVersionPins,
        `${ch.draftVersionPins} panels depend on character/location versions still in draft`,
      );
    if (ch.panels && !ch.narrationLines)
      add("no_narration", "narration", ch.panels, `no ${language} narration (${ch.pages} pages, ${ch.panels} panels)`);
    else if (ch.panels && ch.narratedPanels / ch.panels < 0.9)
      add(
        "narration_gaps",
        "narration",
        ch.panels - ch.narratedPanels,
        `narration covers ${ch.narratedPanels} of ${ch.panels} panels (${Math.round((ch.narratedPanels / ch.panels) * 100)}%)`,
      );
    if (ch.segmentsWithoutAudio)
      add(
        "missing_audio",
        "narration",
        ch.segmentsWithoutAudio,
        `${ch.segmentsWithoutAudio} of ${ch.segments} narration segments have no synthesized audio`,
      );
  }
  return {
    language,
    chapters,
    issues,
    ready: {
      art: !issues.some((i) => i.area === "art" && i.severity === "block"),
      narration: !issues.some((i) => i.area === "narration" && i.severity === "block"),
    },
  };
}

/** Issues that matter for an export kind. */
export const issuesForExport = (r: Readiness, kind: ExportKind) => {
  const areas = kind === "project_import" ? [] : EXPORT_AREAS[kind];
  return r.issues.filter((i) => areas.includes(i.area));
};
