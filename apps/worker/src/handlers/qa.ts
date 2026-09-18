import type { ChatMessage, TextAIProvider } from "@openmanga/ai-text";
import {
  characters,
  characterVersions,
  desc,
  eq,
  generationJobs,
  inArray,
  panelSpecs,
  panels,
  projects,
  sql,
} from "@openmanga/db";
import { panelCheckV1 } from "@openmanga/prompts";
import { CharacterBible, PanelCheck } from "@openmanga/schemas";
import type { WorkerDeps } from "../context.ts";
import { type GenerationJob, InputError, recordTextCalls } from "../lib/runner.ts";
import { batchAware } from "../lib/text-batch-provider.ts";

/** Queue an automatic consistency check for a panel's new artwork when the project opted in. */
export async function maybeQueuePanelCheck(deps: WorkerDeps, job: GenerationJob, panelId: string, assetId: string) {
  const [p] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const cc = p?.settings.consistencyCheck;
  if (!cc?.enabled) return null;
  // The check needs one of the user's vision-capable keys; there is no shared server key to fall back to.
  if (!cc.credentialId && !deps.config.AI_MOCK_MODE) {
    deps.logger.warn("consistency check skipped: no credential configured", { projectId: job.projectId });
    return null;
  }
  // A panel generated through a provider batch has its check batched too: a chapter of batched panels would
  // otherwise generate hundreds of interactive vision calls at full price behind the scenes.
  const batched = job.parameters.batchMode === true;
  const batchId = batched ? (job.batchId ?? null) : null;
  const created = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: job.projectId,
        userId: job.userId,
        kind: "panel_check",
        priority: 8,
        batchId,
        targetType: "panel",
        targetId: panelId,
        templateName: panelCheckV1.name,
        templateVersion: panelCheckV1.version,
        parameters: {
          ai: { credentialId: cc.credentialId, model: cc.model || null },
          assetId,
          ...(batched ? { batchMode: true } : {}),
        },
        input: { panelId, assetId, sourceJobId: job.id },
      },
      { enqueue: !batched },
    ),
  );
  // Batched checks are picked up by the submit sweep in the batch poller, since they are created one panel at a
  // time as each batch is ingested rather than all at once by a route.
  return created;
}

/**
 * Vision QA of a panel: the model counts people and names which expected characters appear; the verdict is then
 * decided here (deterministically) and stored on the panel so the UI can flag it for a re-roll.
 */
export async function panelCheck(deps: WorkerDeps, job: GenerationJob) {
  const panelId = String(job.input.panelId);
  const assetId = String(job.input.assetId);
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (!pn) throw new InputError("Panel no longer exists");
  const asset = await deps.assets.get(assetId);
  if (!asset) throw new InputError("Artwork no longer exists");
  const preview = await deps.assets.ensureResized(asset, "preview");
  const image = preview
    ? { mime: preview.mimeType, data: await deps.assets.readVariant(preview) }
    : { mime: asset.mimeType, data: await deps.assets.read(asset) };

  const ids = pn.characterVersionIds;
  const cast = ids.length
    ? await deps.db
        .select({ name: characters.name, description: characterVersions.description })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, ids))
    : [];
  const [spec] = await deps.db
    .select({ spec: panelSpecs.spec })
    .from(panelSpecs)
    .where(eq(panelSpecs.panelId, panelId))
    .orderBy(desc(panelSpecs.versionNumber))
    .limit(1);
  const expected = cast.map((c) => {
    const b = CharacterBible.parse(c.description);
    return { name: c.name, appearance: [b.hair, b.eyes, b.wardrobe, b.build].filter(Boolean).join("; ") };
  });
  const messages: ChatMessage[] = [...panelCheckV1.build({ expected, beat: spec?.spec.beat ?? pn.storyBeat })];
  messages[1] = { ...messages[1]!, images: [image] };

  const provider = batchAware((await deps.resolver.forJob("text", job)) as TextAIProvider, job, deps.batchCollector);
  const r = await provider.generateStructured({
    messages,
    schema: PanelCheck,
    schemaName: "PanelCheck",
    maxTokens: 8000,
    buildRepairMessages: undefined,
  });
  await recordTextCalls(deps, job, r.calls);
  if (job.parameters.batchAnswer && job.parameters.batchUsageRecorded !== true)
    await deps.db
      .update(generationJobs)
      .set({ parameters: sql`${generationJobs.parameters} || '{"batchUsageRecorded":true}'::jsonb` })
      .where(eq(generationJobs.id, job.id));
  const c = r.data;
  const expectedCount = expected.length;
  const problems = [
    c.missingCharacters.length ? `missing ${c.missingCharacters.join(", ")}` : "",
    c.unexpectedPeople > 0 ? `${c.unexpectedPeople} unexpected ${c.unexpectedPeople === 1 ? "person" : "people"}` : "",
    expectedCount > 0 && c.peopleCount !== expectedCount
      ? `${c.peopleCount} people drawn, ${expectedCount} expected`
      : "",
    expectedCount === 0 && c.peopleCount > 0 ? `${c.peopleCount} people drawn in a panel with no cast` : "",
  ].filter(Boolean);
  const qa = {
    verdict: problems.length ? "mismatch" : "ok",
    problems,
    ...c,
    expected: expected.map((e) => e.name),
    assetId,
    checkedAt: new Date().toISOString(),
    model: r.calls.at(-1)?.model ?? provider.model,
  };
  const [current] = await deps.db
    .select({ active: panels.activeArtworkAssetId, pageId: panels.pageId })
    .from(panels)
    .where(eq(panels.id, panelId));
  // A newer artwork may have replaced the checked one meanwhile: keep the result but mark it stale.
  await deps.db
    .update(panels)
    .set({ qa: current?.active === assetId ? qa : { ...qa, stale: true } })
    .where(eq(panels.id, panelId));
  await deps.events.publish(job.projectId, {
    type: "panel.updated",
    panelId,
    pageId: current?.pageId ?? pn.pageId,
    status: pn.status,
  });
  return { verdict: qa.verdict, problems };
}
