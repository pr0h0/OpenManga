import { and, asc, desc, eq, inArray, panels, promptOverrides, sql } from "@openmanga/db";
import {
  lineDiff,
  OVERRIDABLE,
  overrideSystem,
  panelGenerationV1,
  splitSystem,
  TEXT_TEMPLATES,
  withProjectRules,
} from "@openmanga/prompts";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { badRequest, body, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * The prompt lab: a project's own rules for a built-in prompt (planning, panel prompts, narration; extra rules for
 * panel images), versioned, previewed and diffed against the built-in. The template's header, the rule that story
 * content is data and the answer format are never part of what can be changed.
 */
export const promptLabRoutes = new Hono<AppEnv>();

const Name = z.enum(OVERRIDABLE.map((o) => o.name) as [string, ...string[]]);

/** The newest built-in version of a text template, and its rewritable rules. */
function builtIn(name: string) {
  const meta = OVERRIDABLE.find((o) => o.name === name)!;
  if ("image" in meta && meta.image) return { version: panelGenerationV1.version, rules: "", system: null };
  const t = TEXT_TEMPLATES.filter((x) => x.name === name).sort((a, b) => b.version - a.version)[0];
  if (!t) throw notFound("Template");
  return { version: t.version, rules: splitSystem(t.system).rules, system: t.system };
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/prompt-lab",
  summary:
    "The prompts this project can rewrite, for its format: each with its built-in version and rules, the active override (if any) and every saved version.",
  tag: "projects",
});
promptLabRoutes.get("/projects/:projectId/prompt-lab", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await c
    .get("deps")
    .db.select()
    .from(promptOverrides)
    .where(eq(promptOverrides.projectId, p.id))
    .orderBy(asc(promptOverrides.templateName), desc(promptOverrides.version));
  const format = p.settings.format ?? "comic";
  return c.json({
    templates: OVERRIDABLE.filter((o) => (o.formats as readonly string[]).includes(format)).map((o) => {
      const b = builtIn(o.name);
      const versions = rows.filter((r) => r.templateName === o.name);
      return {
        name: o.name,
        label: o.label,
        image: "image" in o && o.image === true,
        builtInVersion: b.version,
        builtInRules: b.rules,
        active: versions.find((v) => v.active) ?? null,
        versions: versions.map(({ rules: _r, ...v }) => v),
      };
    }),
  });
});

const SaveInput = z.object({
  rules: z.string().trim().min(1).max(30_000),
  note: z.string().trim().max(200).default(""),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/prompt-lab/:name",
  summary:
    "Save new rules for a prompt as the next version and make it active: every later job of that template in this project uses them (recorded on the job).",
  tag: "projects",
  body: SaveInput,
});
promptLabRoutes.post("/projects/:projectId/prompt-lab/:name", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const name = Name.parse(c.req.param("name"));
  const input = await body(c, SaveInput);
  const deps = c.get("deps");
  const row = await deps.db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${promptOverrides.version}), 0)::int` })
      .from(promptOverrides)
      .where(and(eq(promptOverrides.projectId, p.id), eq(promptOverrides.templateName, name)));
    await tx
      .update(promptOverrides)
      .set({ active: false })
      .where(and(eq(promptOverrides.projectId, p.id), eq(promptOverrides.templateName, name)));
    const [r] = await tx
      .insert(promptOverrides)
      .values({
        projectId: p.id,
        templateName: name,
        version: (max?.n ?? 0) + 1,
        rules: input.rules,
        note: input.note,
        active: true,
        createdByUserId: user(c).id,
      })
      .returning();
    return r!;
  });
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "prompt.override",
    targetType: "project",
    targetId: p.id,
    metadata: { template: name, version: row.version },
    requestId: c.get("requestId"),
  });
  return c.json({ override: row }, 201);
});

const ActivateInput = z.object({ version: z.number().int().min(0) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/prompt-lab/:name/activate",
  summary: "Make a saved version the active one (revert to it), or version 0 for the built-in prompt.",
  tag: "projects",
  body: ActivateInput,
});
promptLabRoutes.post("/projects/:projectId/prompt-lab/:name/activate", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const name = Name.parse(c.req.param("name"));
  const { version } = await body(c, ActivateInput);
  const { db } = c.get("deps");
  const mine = and(eq(promptOverrides.projectId, p.id), eq(promptOverrides.templateName, name));
  if (version > 0) {
    const [v] = await db
      .select({ id: promptOverrides.id })
      .from(promptOverrides)
      .where(and(mine, eq(promptOverrides.version, version)));
    if (!v) throw notFound("Version");
  }
  await db.transaction(async (tx) => {
    await tx.update(promptOverrides).set({ active: false }).where(mine);
    if (version > 0)
      await tx
        .update(promptOverrides)
        .set({ active: true })
        .where(and(mine, eq(promptOverrides.version, version)));
  });
  return c.json({ ok: true });
});

const PreviewInput = z.object({
  /** Rules to try: unsaved ones; left out, the active version (or the built-in). */
  rules: z.string().max(30_000).optional(),
  version: z.number().int().min(1).optional(),
  /** Panel images: the panels to compile (up to 3). */
  panelIds: z.array(z.string().uuid()).max(3).default([]),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/prompt-lab/:name/preview",
  summary:
    "Preview a prompt with given rules (unsaved, a saved version, or the active one): a text template's whole system prompt and its line diff against the built-in; for panel images, the compiled prompt of up to 3 panels. Nothing is run.",
  tag: "projects",
  body: PreviewInput,
});
promptLabRoutes.post("/projects/:projectId/prompt-lab/:name/preview", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const name = Name.parse(c.req.param("name"));
  const input = await body(c, PreviewInput);
  const deps = c.get("deps");
  const mine = and(eq(promptOverrides.projectId, p.id), eq(promptOverrides.templateName, name));
  const [chosen] = input.version
    ? await deps.db
        .select()
        .from(promptOverrides)
        .where(and(mine, eq(promptOverrides.version, input.version)))
    : await deps.db
        .select()
        .from(promptOverrides)
        .where(and(mine, eq(promptOverrides.active, true)));
  if (input.version && !chosen) throw notFound("Version");
  const b = builtIn(name);
  const rules = input.rules ?? chosen?.rules ?? b.rules;
  if (b.system) {
    const system = rules === b.rules ? b.system : overrideSystem(b.system, rules);
    return c.json({ system, diff: lineDiff(b.rules, rules) });
  }
  if (!input.panelIds.length) throw badRequest("Pick up to 3 panels to preview");
  const own = await deps.db
    .select({ id: panels.id })
    .from(panels)
    .where(and(eq(panels.projectId, p.id), inArray(panels.id, input.panelIds)));
  if (own.length !== input.panelIds.length) throw badRequest("A panel is not in this project");
  const out = [];
  for (const id of input.panelIds) {
    const ctx = await deps.planner.panelContext(id);
    out.push({ panelId: id, prompt: withProjectRules(panelGenerationV1.compile(ctx.input), rules) });
  }
  return c.json({ panels: out, diff: lineDiff(b.rules, rules) });
});
