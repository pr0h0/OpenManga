import type { ChatMessage, TextAIProvider } from "@openmanga/ai-text";
import {
  characters,
  characterVersions,
  desc,
  dialogueLines,
  eq,
  generationJobs,
  inArray,
  narrationLines,
  pages,
  panelSpecs,
  panels,
  projects,
  sql,
} from "@openmanga/db";
import { autoFixDecision, coveredFaces, facesOnPage, visualCheckModes } from "@openmanga/domain";
import { computeCrop } from "@openmanga/image-utils";
import { panelCheckV1 } from "@openmanga/prompts";
import { CharacterBible, MODEL_ASPECTS, type ModelAspect, PanelCheck, type VisualCheck } from "@openmanga/schemas";
import {
  type AiChoice,
  credentialOwnedBy,
  GenerationPlanner,
  providerInfo,
  resolveOutfits,
  wardrobeText,
} from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { formatPrompt, isManual, manualProvider } from "../lib/manual-provider.ts";
import { InputError, type ProjectJob, recordTextCalls } from "../lib/runner.ts";
import { batchAware } from "../lib/text-batch-provider.ts";

/** Queue an automatic consistency check for a panel's new artwork when the project opted in. */
export async function maybeQueuePanelCheck(deps: WorkerDeps, job: ProjectJob, panelId: string, assetId: string) {
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
  // The project's check key is one member's: another member's panels are not checked on it (they would fail anyway).
  if (cc.credentialId && !(await credentialOwnedBy(deps.db, cc.credentialId, job.userId))) return null;
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
export async function panelCheck(deps: WorkerDeps, job: ProjectJob) {
  const panelId = String(job.input.panelId);
  const assetId = String(job.input.assetId);
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (!pn) throw new InputError("Panel no longer exists");
  const asset = await deps.assets.get(assetId);
  if (!asset) throw new InputError("Artwork no longer exists");
  const preview = await deps.assets.ensureResized(asset, "preview");
  const image = preview
    ? { mime: preview.mimeType, data: await deps.assets.readVariant(preview), assetId: asset.id }
    : { mime: asset.mimeType, data: await deps.assets.read(asset), assetId: asset.id };

  const ids = pn.characterVersionIds;
  const cast = ids.length
    ? await deps.db
        .select({
          id: characters.id,
          versionId: characterVersions.id,
          name: characters.name,
          description: characterVersions.description,
        })
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
  // Judge the clothes against the outfit the panel was drawn in, not the bible's default wardrobe, or every
  // outfit change reads as a mismatch.
  const textOf = (id: string) => spec?.spec.characters.find((x) => x.characterId === id)?.outfit;
  const worn = await resolveOutfits(
    deps.db,
    panelId,
    cast.map((c) => ({ id: c.id, text: textOf(c.id), versionId: c.versionId })),
  );
  const expected = cast.map((c) => {
    const b = CharacterBible.parse(c.description);
    const w = worn.get(c.id);
    const wardrobe = w ? wardrobeText(w, [w.outfit], textOf(c.id)) : textOf(c.id) || b.wardrobe;
    const asked = spec?.spec.characters.find((x) => x.characterId === c.id);
    return {
      name: c.name,
      appearance: [b.hair, b.eyes, wardrobe, b.build].filter(Boolean).join("; "),
      ...(asked?.expression ? { expression: asked.expression } : {}),
      ...(asked?.pose ? { pose: asked.pose } : {}),
    };
  });

  // Which aspects to ask about: the ones the project turned on that this panel gives something to judge against.
  const [proj] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const cc = proj?.settings.consistencyCheck;
  const modes = visualCheckModes(cc?.checks);
  const planner = new GenerationPlanner(
    deps.db,
    deps.assets,
    deps.jobs,
    providerInfo(deps.config).image,
    deps.resolver,
  );
  const input = await planner
    .panelContext(panelId)
    .then((x) => x.input)
    .catch(() => null);
  const poseGuide = input?.guide?.strength === "strict" ? (input.guide.pose ?? "").trim() : "";
  const judgeable: Record<ModelAspect, boolean> = {
    identity: expected.length > 0,
    outfit: expected.length > 0,
    props: Boolean(input?.props.length),
    location: Boolean(input?.location),
    expression: expected.some((e) => e.expression) || Boolean(spec?.spec.emotion),
    pose: Boolean(poseGuide),
    framing: Boolean(input),
    anatomy: true,
    style: Boolean(input),
    palette: Boolean(input),
  };
  const checks = MODEL_ASPECTS.filter((a) => modes[a] !== "off" && judgeable[a]);
  const context = input
    ? {
        props: input.props.map((x) => ({ name: x.name, description: x.description })),
        location: input.location ? { name: input.location.name, description: input.location.description } : null,
        shotType: input.panel.shotType,
        cameraAngle: input.panel.cameraAngle ?? "",
        emotion: spec?.spec.emotion ?? "",
        poseGuide,
        style: [input.style.presetName, input.style.customDescription].filter(Boolean).join("; "),
        colorDirective: input.style.colorDirective,
      }
    : undefined;
  const messages: ChatMessage[] = [
    ...panelCheckV1.build({ expected, beat: spec?.spec.beat ?? pn.storyBeat, checks, context }),
  ];
  messages[1] = { ...messages[1]!, images: [image] };

  // A keyless check is answered by a person looking at the same image, like every other manual text step.
  const provider = isManual(job)
    ? manualProvider(job)
    : batchAware((await deps.resolver.forJob("text", job)) as TextAIProvider, job, deps.batchCollector);
  const r = await provider.generateStructured({
    messages,
    schema: PanelCheck,
    schemaName: "PanelCheck",
    maxTokens: 8000,
    buildRepairMessages: undefined,
  });
  await recordTextCalls(deps, job, r.calls);
  // Shown on the job page like every other text step's prompt: what the check was told to expect.
  await deps.db
    .update(generationJobs)
    .set({ compiledPrompt: formatPrompt(messages) })
    .where(eq(generationJobs.id, job.id));
  if (job.parameters.batchAnswer && job.parameters.batchUsageRecorded !== true)
    await deps.db
      .update(generationJobs)
      .set({ parameters: sql`${generationJobs.parameters} || '{"batchUsageRecorded":true}'::jsonb` })
      .where(eq(generationJobs.id, job.id));
  const c = r.data;
  const expectedCount = expected.length;
  const failed = new Set<VisualCheck>();
  const problems: string[] = [];
  const flag = (k: VisualCheck, text: string) => {
    if (!text || modes[k] === "off") return;
    failed.add(k);
    problems.push(text);
  };
  flag("headcount", c.missingCharacters.length ? `missing ${c.missingCharacters.join(", ")}` : "");
  flag(
    "headcount",
    c.unexpectedPeople > 0 ? `${c.unexpectedPeople} unexpected ${c.unexpectedPeople === 1 ? "person" : "people"}` : "",
  );
  flag(
    "headcount",
    expectedCount > 0 && c.peopleCount !== expectedCount
      ? `${c.peopleCount} people drawn, ${expectedCount} expected`
      : "",
  );
  flag(
    "headcount",
    expectedCount === 0 && c.peopleCount > 0 ? `${c.peopleCount} people drawn in a panel with no cast` : "",
  );
  // Panel art must carry no text: lettering is added on top, and model-drawn text is garbled.
  flag("text", c.readableText ? "readable text drawn in the art" : "");
  for (const a of checks) {
    const v = c.aspects[a];
    if (v && !v.ok) flag(a, `${a}: ${v.note || "does not match"}`);
  }
  const hidden = modes.covered_faces === "off" ? [] : await facesUnderLettering(deps, pn, asset, c.faces);
  flag("covered_faces", hidden.length ? `lettering covers ${hidden.join(", ")}'s face` : "");

  // A failure set to regenerate re-rolls the panel, while it still shows the checked artwork and the check is on.
  const [current] = await deps.db
    .select({ active: panels.activeArtworkAssetId, pageId: panels.pageId })
    .from(panels)
    .where(eq(panels.id, panelId));
  let autoFix: { jobId: string; attempt: number } | { skipped: string } | undefined;
  if (failed.size && cc?.enabled && current?.active === assetId) {
    // Counted from the job that drew the checked artwork, so a check run by hand continues the same count.
    const sourceId = asset.generationJobId;
    const [source] = sourceId
      ? await deps.db
          .select({ parameters: generationJobs.parameters })
          .from(generationJobs)
          .where(eq(generationJobs.id, sourceId))
      : [];
    const attempt = Number(source?.parameters.autoFix ?? 0);
    const [spent] = await deps.db.execute<{ usd: number }>(sql`
      select coalesce(sum(u.estimated_cost_usd), 0)::float as usd from ai_usage u
      join generation_jobs j on j.id = u.generation_job_id
      where j.project_id = ${job.projectId} and j.parameters ? 'autoFix'`);
    const d = autoFixDecision({
      failed: [...failed],
      modes,
      attempt,
      spentUsd: spent?.usd ?? 0,
      budgetUsd: cc.autoFixBudgetUsd ?? 2,
    });
    if (d.regenerate) {
      const next = await planner.enqueuePanel(panelId, job.userId, {
        priority: 6,
        regenerationOf: assetId,
        operation: "visual-check",
        ai: (source?.parameters.ai as AiChoice | undefined) ?? null,
        autoFix: attempt + 1,
      });
      autoFix = { jobId: next.id, attempt: attempt + 1 };
    } else if (d.reason) autoFix = { skipped: d.reason };
  }
  const qa = {
    verdict: problems.length ? "mismatch" : "ok",
    problems,
    failed: [...failed],
    checks,
    ...(autoFix ? { autoFix } : {}),
    ...c,
    expected: expected.map((e) => e.name),
    assetId,
    checkedAt: new Date().toISOString(),
    model: r.calls.at(-1)?.model ?? provider.model,
  };
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
  return { verdict: qa.verdict, problems, ...(autoFix ? { autoFix } : {}) };
}

/** Names of the faces in the checked artwork that the panel's bubbles or caption boxes hide. */
async function facesUnderLettering(
  deps: WorkerDeps,
  pn: typeof panels.$inferSelect,
  art: { width: number | null; height: number | null },
  faces: PanelCheck["faces"],
) {
  if (!faces.length || !art.width || !art.height) return [];
  const [pg] = await deps.db.select().from(pages).where(eq(pages.id, pn.pageId));
  if (!pg) return [];
  const boxes = [
    ...(await deps.db.select({ b: dialogueLines.bubble }).from(dialogueLines).where(eq(dialogueLines.panelId, pn.id))),
    ...(await deps.db.select({ b: narrationLines.box }).from(narrationLines).where(eq(narrationLines.panelId, pn.id))),
  ]
    .map((r) => r.b)
    .filter((b): b is NonNullable<typeof b> => Boolean(b));
  if (!boxes.length) return [];
  const crop = computeCrop(
    art.width,
    art.height,
    (pn.frame.width * pg.width) / (pn.frame.height * pg.height),
    pn.imageTransform,
  );
  return coveredFaces(facesOnPage(faces, pn.frame, { width: art.width, height: art.height }, crop, 0), boxes).map(
    (f) => f.name,
  );
}
