ALTER TABLE "chapters" ADD COLUMN "plan_fingerprint" text;--> statement-breakpoint
ALTER TABLE "chapters" ADD COLUMN "narration_fingerprint" text;--> statement-breakpoint
-- Backfill: chapters already planned or narrated count as up to date on upgrade.
UPDATE "chapters" SET "plan_fingerprint" = md5(btrim(coalesce(nullif(btrim(chapters.source_excerpt, E' \n\r\t'), ''), chapters.summary), E' \n\r\t'))
WHERE EXISTS (SELECT 1 FROM "pages" p WHERE p."chapter_id" = "chapters"."id");--> statement-breakpoint
UPDATE "chapters" SET "narration_fingerprint" = md5(coalesce((
  select string_agg(pn.id::text || ':' || pn.story_beat || ':' || coalesce((
      select string_agg(d.text, '|' order by d."order", d.id) from dialogue_lines d where d.panel_id = pn.id), ''),
    E'\n' order by p."order", pn."order", pn.id)
  from panels pn join pages p on p.id = pn.page_id where p.chapter_id = chapters.id), ''))
WHERE EXISTS (SELECT 1 FROM "narration_lines" nl JOIN "projects" pr ON pr."id" = nl."project_id"
  WHERE nl."chapter_id" = "chapters"."id" AND nl."language" = pr."language");
