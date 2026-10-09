import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, pages, panels, users } from "@openmanga/db";
import { customLayoutFrames, customLayoutKey, MAX_PANELS_PER_PAGE, pickLayout } from "@openmanga/domain";
import { type CustomLayout, UserSettings } from "@openmanga/schemas";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { fitPanels } from "../lib/layouts.ts";
import { doc } from "../lib/openapi.ts";

export const layoutRoutes = new Hono<AppEnv>();

const mine = (c: Context<AppEnv>) => user(c).settings.layouts ?? [];
async function saveMine(c: Context<AppEnv>, layouts: CustomLayout[]) {
  const u = user(c);
  const settings = UserSettings.parse({ ...u.settings, layouts });
  await c.get("deps").db.update(users).set({ settings }).where(eq(users.id, u.id));
}

doc({
  method: "GET",
  path: "/api/layouts",
  summary: "Your saved page layouts, usable in any of your projects (as `custom:<id>` page layout keys)",
  tag: "pages",
});
layoutRoutes.get("/layouts", (c) => c.json({ layouts: mine(c) }));

const SaveLayout = z.object({
  name: z.string().trim().min(1).max(80),
  /** The page whose panels (frames, shapes and borders) become the layout. */
  pageId: z.string().uuid(),
});
doc({
  method: "POST",
  path: "/api/layouts",
  summary:
    "Save a page's arrangement as one of your layouts: its panels' frames in panel order, shapes and borders included (at most 5 panels, 100 layouts).",
  tag: "pages",
  body: SaveLayout,
});
layoutRoutes.post("/layouts", async (c) => {
  const input = await body(c, SaveLayout);
  const project = await entityAccess(c, "page", input.pageId, "read");
  const { db } = c.get("deps");
  const [pg] = await db.select().from(pages).where(eq(pages.id, input.pageId));
  const pns = await db.select().from(panels).where(eq(panels.pageId, input.pageId)).orderBy(asc(panels.order));
  if (!pns.length) throw badRequest("That page has no panels to save");
  if (pns.length > MAX_PANELS_PER_PAGE) throw badRequest(`A layout has at most ${MAX_PANELS_PER_PAGE} panels`);
  const list = mine(c);
  if (list.length >= 100) throw badRequest("You have 100 layouts; delete one first");
  const dir = pg?.readingDirection ?? project.readingDirection;
  const layout: CustomLayout = {
    id: randomUUID(),
    name: input.name,
    frames: pns.map((p) => p.frame),
    readingDirection: dir === "rtl" ? "rtl" : "ltr",
  };
  await saveMine(c, [...list, layout]);
  return c.json({ layout }, 201);
});

const Rename = z.object({ name: z.string().trim().min(1).max(80) });
doc({ method: "PATCH", path: "/api/layouts/:id", summary: "Rename one of your layouts", tag: "pages", body: Rename });
layoutRoutes.patch("/layouts/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { name } = await body(c, Rename);
  const list = mine(c);
  if (!list.some((l) => l.id === id)) throw notFound("Layout");
  await saveMine(
    c,
    list.map((l) => (l.id === id ? { ...l, name } : l)),
  );
  return c.json({ layout: { ...list.find((l) => l.id === id)!, name } });
});

doc({
  method: "DELETE",
  path: "/api/layouts/:id",
  summary: "Delete one of your layouts. Projects that use a copy of it keep their copy.",
  tag: "pages",
});
layoutRoutes.delete("/layouts/:id", async (c) => {
  const id = uuidParam(c, "id");
  const list = mine(c);
  if (!list.some((l) => l.id === id)) throw notFound("Layout");
  await saveMine(
    c,
    list.filter((l) => l.id !== id),
  );
  return c.json({ ok: true });
});

const Apply = z.object({
  /** Which of the project's layouts to use; all of them when left out. */
  layoutIds: z.array(z.string().uuid()).max(30).optional(),
});

/**
 * Re-lays pages with the project's layouts: each page takes one with its panel count, in turn (the k-th page with
 * n panels gets the k-th n-panel layout, wrapping round). Pages no layout fits, and locked pages, are left as they are.
 */
async function applyLayouts(c: Context<AppEnv>, projectId: string, chapterId: string | null) {
  const project = await projectAccess(c, projectId, "write");
  const fmt = project.settings.format;
  if (fmt === "film" || fmt === "vertical")
    throw conflict("Page layouts are for comic pages; film and strips use one frame per page");
  const input = await body(c, Apply);
  const set = (project.settings.layouts ?? []).filter((l) => !input.layoutIds || input.layoutIds.includes(l.id));
  if (!set.length) throw badRequest("Add a layout to the project first (project settings → Page layouts)");
  const { db } = c.get("deps");
  const pgs = await db
    .select()
    .from(pages)
    .where(chapterId ? eq(pages.chapterId, chapterId) : eq(pages.projectId, project.id))
    .orderBy(asc(pages.chapterId), asc(pages.order));
  const pns = pgs.length
    ? await db
        .select({ id: panels.id, pageId: panels.pageId, order: panels.order })
        .from(panels)
        .where(
          inArray(
            panels.pageId,
            pgs.map((p) => p.id),
          ),
        )
        .orderBy(asc(panels.order))
    : [];
  const seen = new Map<number, number>();
  let changed = 0;
  let skipped = 0;
  await db.transaction(async (tx) => {
    for (const pg of pgs) {
      const own = pns.filter((p) => p.pageId === pg.id);
      const n = own.length;
      const k = seen.get(n) ?? 0;
      const layout = pg.status === "locked" ? null : pickLayout(set, n, k);
      if (!layout) {
        skipped++;
        continue;
      }
      seen.set(n, k + 1);
      const frames = customLayoutFrames(layout, pg.readingDirection ?? project.readingDirection);
      const { fitted } = fitPanels(n, frames, project.settings.pageMargin);
      for (const [i, p] of own.entries())
        await tx
          .update(panels)
          .set({ frame: fitted[i]! })
          .where(and(eq(panels.id, p.id), eq(panels.pageId, pg.id)));
      await tx
        .update(pages)
        .set({ layoutTemplate: customLayoutKey(layout.id) })
        .where(eq(pages.id, pg.id));
      changed++;
    }
  });
  return c.json({ changed, skipped });
}

doc({
  method: "POST",
  path: "/api/chapters/:id/apply-layouts",
  summary:
    "Re-lay every page of a chapter with the project's layouts (or the `layoutIds` given): each page takes one with its panel count, in turn. Pages no layout fits, and locked ones, stay as they are. Returns how many changed and were skipped.",
  tag: "pages",
  body: Apply,
});
layoutRoutes.post("/chapters/:id/apply-layouts", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "write");
  return applyLayouts(c, project.id, chapterId);
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/apply-layouts",
  summary: "The same for every page of the project.",
  tag: "pages",
  body: Apply,
});
layoutRoutes.post("/projects/:projectId/apply-layouts", (c) => applyLayouts(c, uuidParam(c, "projectId"), null));
