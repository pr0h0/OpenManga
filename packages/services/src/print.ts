import { and, asc, assets, chapters, type Database, eq, inArray, pages, type projects } from "@openmanga/db";
import { coverLayout, interiorSequence, type PaperType, trimSizeIn } from "@openmanga/domain";

/** Which pages a print export covers: a page selection, a chapter, or the whole project. */
export type PrintScope = { chapterId: string | null; pageIds?: string[] };
/** The print options the cover and the interior share. */
export type PrintOptions = {
  pageSize: string;
  toc?: boolean;
  rectoChapters?: boolean;
  readingDirection?: "ltr" | "rtl" | "vertical";
  print?: { paper?: PaperType; pageCount?: number; paperThicknessMm?: number };
};

/** The scope's chapters in reading order, each with its page ids in order. Always within the project. */
export async function printChapters(db: Database, projectId: string, scope: PrintScope) {
  const rows = await db
    .select({ id: pages.id, chapterId: chapters.id, title: chapters.title, order: chapters.order })
    .from(pages)
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(
      and(
        eq(pages.projectId, projectId),
        scope.pageIds?.length
          ? inArray(pages.id, scope.pageIds)
          : scope.chapterId
            ? eq(pages.chapterId, scope.chapterId)
            : undefined,
      ),
    )
    .orderBy(asc(chapters.order), asc(pages.order));
  const out: { id: string; title: string; order: number; pageIds: string[] }[] = [];
  for (const r of rows) {
    if (out.at(-1)?.id !== r.chapterId) out.push({ id: r.chapterId, title: r.title, order: r.order, pageIds: [] });
    out.at(-1)!.pageIds.push(r.id);
  }
  return out;
}

/**
 * The wraparound cover for a project and its interior: the interior's page count (as the PDF with the same contents
 * and recto options prints it, unless given), the cover art's size, and the layout with its issues. Reads no image.
 */
export async function printCoverCheck(
  db: Database,
  project: typeof projects.$inferSelect,
  scope: PrintScope,
  o: PrintOptions,
) {
  const trim = trimSizeIn(o.pageSize);
  if (!trim) return null;
  let pageCount = o.print?.pageCount;
  if (!pageCount) {
    const chs = await printChapters(db, project.id, scope);
    pageCount = interiorSequence(chs, { cover: false, toc: Boolean(o.toc), rectoChapters: Boolean(o.rectoChapters) })
      .entries.length;
  }
  const [art] = project.coverAssetId
    ? await db
        .select({ id: assets.id, width: assets.width, height: assets.height })
        .from(assets)
        .where(eq(assets.id, project.coverAssetId))
    : [];
  const layout = coverLayout({
    trimIn: trim,
    pageCount,
    paper: o.print?.paper ?? "white",
    paperThicknessMm: o.print?.paperThicknessMm,
    art: art?.width && art.height ? { width: art.width, height: art.height } : null,
    title: project.title,
    author: project.settings.author ?? "",
    description: project.description,
    rtl: (o.readingDirection ?? project.readingDirection) === "rtl",
  });
  return { pageCount, layout, artAssetId: art?.id ?? null };
}
