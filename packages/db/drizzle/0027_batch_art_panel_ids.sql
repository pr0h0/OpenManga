-- Panel artwork that came back from a provider batch was stored without its panel id, so the Versions tab (which finds a
-- panel's artwork by metadata.panelId) never listed it. Give it the panel and page its job drew, as a direct run records.
UPDATE "assets" AS a
SET "metadata" = a."metadata" || jsonb_build_object('panelId', j."target_id"::text)
  || CASE WHEN pn."page_id" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('pageId', pn."page_id"::text) END
FROM "generation_jobs" AS j
LEFT JOIN "panels" AS pn ON pn."id" = j."target_id"
WHERE a."generation_job_id" = j."id"
  AND a."type" = 'panel_art'
  AND j."kind" = 'panel_generation'
  AND j."target_id" IS NOT NULL
  AND (a."metadata" ->> 'panelId') IS NULL;
