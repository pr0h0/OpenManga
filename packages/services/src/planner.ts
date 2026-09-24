import {
  and,
  asc,
  assets,
  characterOutfits,
  characters,
  characterVersions,
  type Database,
  desc,
  eq,
  inArray,
  isNull,
  locations,
  locationVersions,
  pages,
  panelSpecs,
  panels,
  projectStyles,
  projects,
  props,
  propVersions,
  type ReferenceKind,
  referenceAssets,
  scenes,
  sql,
  stylePresets,
} from "@openmanga/db";
import { aspectRatioOf, COLOR_MODE_DIRECTIVES } from "@openmanga/domain";
import {
  characterReferenceV1,
  coverV1,
  locationReferenceV1,
  type PanelCharacterContext,
  type PanelPromptInput,
  panelEditV1,
  panelGenerationV1,
  propReferenceV1,
  type StyleContext,
  styleReferenceV1,
} from "@openmanga/prompts";
import { CharacterBible, type PanelSpec, type ProjectSettings } from "@openmanga/schemas";
import type { AssetRecord, AssetService } from "./assets.ts";
import type { JobService, NewGenerationInput } from "./jobs.ts";
import { outfitReferenceAssets, resolveOutfits, wardrobeText } from "./outfits.ts";
import { type AiChoice, MISSING_CREDENTIAL, type ProviderResolver } from "./providers.ts";
import { versionFingerprint } from "./staleness.ts";

export class PlanningError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 422,
    message: string,
  ) {
    super(message);
  }
}

export type ProviderInfo = { provider: string; model: string; quality: string };

const KIND_ORDER: ReferenceKind[] = [
  "portrait",
  "full_body",
  "multi_angle",
  "uploaded",
  "outfit",
  "expression_sheet",
  "location",
  "location_sheet",
  "location_panorama",
  "prop",
  "prop_multi_angle",
  "style",
];

export const REFERENCE_ASPECT: Record<string, number> = {
  portrait: 2 / 3,
  full_body: 2 / 3,
  multi_angle: 3 / 2,
  expression_sheet: 3 / 2,
  outfit: 2 / 3,
  location: 3 / 2,
  location_panorama: 3 / 2,
  location_sheet: 3 / 2,
  prop: 1,
  prop_multi_angle: 3 / 2,
  style: 2 / 3,
  cover: 2 / 3,
};

type RefSubject = "character" | "location" | "prop" | "style";
const MAX_REFERENCES = 8;

export class GenerationPlanner {
  constructor(
    private readonly db: Database,
    private readonly assetsSvc: AssetService,
    private readonly jobs: JobService,
    /** Only set in AI_MOCK_MODE; every real run carries the user's own key. */
    private readonly image: ProviderInfo | null,
    private readonly resolver?: ProviderResolver,
  ) {}

  /** Provider/model recorded on an image job; a BYOK or model choice is validated here (owner, capability). */
  private async imageRun(ai: AiChoice | null | undefined, userId: string | null) {
    if (!this.resolver || (!ai?.credentialId && !ai?.provider && !ai?.model?.trim())) {
      // No shared server keys: without a chosen credential only the mock provider can run.
      if (!this.image) throw new PlanningError(422, MISSING_CREDENTIAL);
      return { provider: this.image.provider, model: this.image.model, ai: null };
    }
    const p = await this.resolver.image(ai, userId);
    return {
      provider: p.provider,
      model: p.model,
      ai: {
        credentialId: ai.credentialId ?? null,
        provider: ai.credentialId ? null : (ai.provider ?? null),
        model: ai.model?.trim() || p.model,
      },
    };
  }

  async project(projectId: string) {
    const [p] = await this.db.select().from(projects).where(eq(projects.id, projectId));
    if (!p) throw new PlanningError(404, "Project not found");
    return p;
  }

  async styleContext(
    projectId: string,
  ): Promise<{ style: StyleContext; styleId: string | null; styleRef: AssetRecord | null }> {
    const p = await this.project(projectId);
    const [ps] = p.currentStyleId
      ? await this.db.select().from(projectStyles).where(eq(projectStyles.id, p.currentStyleId))
      : await this.db
          .select()
          .from(projectStyles)
          .where(eq(projectStyles.projectId, projectId))
          .orderBy(desc(projectStyles.versionNumber))
          .limit(1);
    const [preset] = ps?.stylePresetId
      ? await this.db.select().from(stylePresets).where(eq(stylePresets.id, ps.stylePresetId))
      : [];
    const styleRef = ps ? await this.approvedReference("style", ps.id) : null;
    return {
      style: {
        presetName: preset?.name ?? null,
        definition: preset?.definition ?? null,
        customDescription: ps?.customDescription ?? "",
        colorDirective: COLOR_MODE_DIRECTIVES[p.colorMode],
        projectType: p.projectType,
      },
      styleId: ps?.id ?? null,
      styleRef,
    };
  }

  /** Approved/locked canonical reference for a subject version. Drafts are never used for identity. */
  async approvedReference(
    subject: RefSubject,
    versionId: string,
  ): Promise<(AssetRecord & { referenceKind: ReferenceKind }) | null> {
    const col =
      subject === "character"
        ? referenceAssets.characterVersionId
        : subject === "location"
          ? referenceAssets.locationVersionId
          : subject === "prop"
            ? referenceAssets.propVersionId
            : referenceAssets.projectStyleId;
    const rows = await this.db
      .select({ ref: referenceAssets, asset: assets })
      .from(referenceAssets)
      .innerJoin(assets, eq(assets.id, referenceAssets.assetId))
      .where(and(eq(col, versionId), inArray(referenceAssets.status, ["approved", "locked"]), isNull(assets.deletedAt)))
      .orderBy(desc(referenceAssets.isPrimary), desc(referenceAssets.createdAt));
    rows.sort(
      (a, b) =>
        Number(b.ref.isPrimary) - Number(a.ref.isPrimary) ||
        KIND_ORDER.indexOf(a.ref.kind) - KIND_ORDER.indexOf(b.ref.kind),
    );
    return rows[0] ? { ...rows[0].asset, referenceKind: rows[0].ref.kind } : null;
  }

  private async derivativeInput(
    asset: AssetRecord,
    role: NewGenerationInput["role"],
    label: string,
    subjectVersionId: string | null,
    settings: ProjectSettings,
    provider: string | null = null,
  ): Promise<NewGenerationInput> {
    const params = this.assetsSvc.referenceParams({
      maxWidth: settings.referenceMaxWidth,
      maxHeight: settings.referenceMaxHeight,
      provider,
    });
    const v = await this.assetsSvc.ensurePromptReference(asset, params);
    return {
      role,
      assetId: asset.id,
      variantId: v.id,
      subjectVersionId,
      label,
      width: v.width,
      height: v.height,
      metadata: {
        derivative: "prompt_ref",
        canonicalWidth: asset.width,
        canonicalHeight: asset.height,
        canonicalSha256: asset.sha256,
        referenceWidth: v.width,
        referenceHeight: v.height,
        maxWidth: params.maxWidth,
        maxHeight: params.maxHeight,
        fit: params.fit,
        format: params.format,
        referenceBytes: v.byteSize,
      },
    };
  }

  /** Assemble structured prompt input + reference plan for a panel (used by preview and generation). */
  async panelContext(panelId: string, opts: { includePreviousPanel?: boolean } = {}) {
    const [row] = await this.db
      .select({ panel: panels, page: pages })
      .from(panels)
      .innerJoin(pages, eq(pages.id, panels.pageId))
      .where(eq(panels.id, panelId));
    if (!row) throw new PlanningError(404, "Panel not found");
    const { panel, page } = row;
    const project = await this.project(panel.projectId);
    const settings = project.settings;
    const [specRow] = await this.db
      .select()
      .from(panelSpecs)
      .where(eq(panelSpecs.panelId, panelId))
      .orderBy(desc(panelSpecs.versionNumber))
      .limit(1);
    const spec: PanelSpec | null = specRow?.spec ?? null;
    const { style, styleRef } = await this.styleContext(panel.projectId);

    const refs: {
      asset: AssetRecord;
      role: NewGenerationInput["role"];
      label: string;
      subjectVersionId: string | null;
    }[] = [];

    const charRows = panel.characterVersionIds.length
      ? await this.db
          .select({ v: characterVersions, c: characters })
          .from(characterVersions)
          .innerJoin(characters, eq(characters.id, characterVersions.characterId))
          .where(inArray(characterVersions.id, panel.characterVersionIds))
      : [];
    charRows.sort((a, b) => panel.characterVersionIds.indexOf(a.v.id) - panel.characterVersionIds.indexOf(b.v.id));
    const chars: PanelCharacterContext[] = [];
    const specOf = (c: (typeof charRows)[number]["c"]) =>
      spec?.characters.find((x) => x.characterId === c.id || x.characterId === c.analysisKey) ?? null;
    const worn = await resolveOutfits(
      this.db,
      panelId,
      charRows.map(({ c, v }) => ({ id: c.id, text: specOf(c)?.outfit, versionId: v.id })),
    );
    const allOutfits = worn.size
      ? await this.db
          .select()
          .from(characterOutfits)
          .where(
            inArray(
              characterOutfits.characterId,
              charRows.map(({ c }) => c.id),
            ),
          )
      : [];
    for (const { v, c } of charRows) {
      const ref = await this.approvedReference("character", v.id);
      const pc = specOf(c);
      let referenceImageIndex: number | undefined;
      if (ref && refs.length < MAX_REFERENCES) {
        refs.push({
          asset: ref,
          role: "character_ref",
          label: `${c.name} v${v.versionNumber}`,
          subjectVersionId: v.id,
        });
        referenceImageIndex = refs.length;
      }
      // Identity reference first; the reference of the outfit this panel resolves to comes right after.
      let outfitReference: PanelCharacterContext["outfitReference"];
      const outfit = worn.get(c.id);
      const outfitAsset = outfit
        ? (await outfitReferenceAssets(this.db, [outfit.outfit.id], v.id)).get(outfit.outfit.id)
        : undefined;
      if (outfit && outfitAsset && outfitAsset.id !== ref?.id && refs.length < MAX_REFERENCES) {
        refs.push({
          asset: outfitAsset,
          role: "character_ref",
          label: `${c.name} outfit: ${outfit.outfit.name}`,
          subjectVersionId: v.id,
        });
        outfitReference = { name: outfit.outfit.name, imageIndex: refs.length };
      }
      // The resolved outfit's own description is what the WARDROBE line reads; the panel's text stays as a detail.
      const wardrobe = outfit
        ? wardrobeText(
            outfit,
            allOutfits.filter((o) => o.characterId === c.id),
            pc?.outfit,
          )
        : undefined;
      chars.push({
        name: c.name,
        versionNumber: v.versionNumber,
        bible: CharacterBible.parse(v.description),
        immutableTraits: v.immutableTraits,
        outfit: wardrobe,
        referenceImageIndex,
        outfitReference,
        panel: pc && wardrobe ? { ...pc, outfit: wardrobe } : pc,
      });
    }

    let location: PanelPromptInput["location"] = null;
    if (panel.locationVersionId) {
      const [l] = await this.db
        .select({ v: locationVersions, l: locations })
        .from(locationVersions)
        .innerJoin(locations, eq(locations.id, locationVersions.locationId))
        .where(eq(locationVersions.id, panel.locationVersionId));
      if (l) {
        const ref = await this.approvedReference("location", l.v.id);
        let referenceImageIndex: number | undefined;
        if (ref && refs.length < MAX_REFERENCES) {
          refs.push({
            asset: ref,
            role: "location_ref",
            label: `${l.l.name} v${l.v.versionNumber}`,
            subjectVersionId: l.v.id,
          });
          referenceImageIndex = refs.length;
        }
        location = {
          name: l.l.name,
          description: l.v.description,
          referenceImageIndex,
          referenceKind: referenceImageIndex ? ref?.referenceKind : undefined,
        };
      }
    }

    const propCtx: PanelPromptInput["props"] = [];
    if (panel.propVersionIds.length) {
      const prs = await this.db
        .select({ v: propVersions, p: props })
        .from(propVersions)
        .innerJoin(props, eq(props.id, propVersions.propId))
        .where(inArray(propVersions.id, panel.propVersionIds));
      for (const pr of prs) {
        const ref = await this.approvedReference("prop", pr.v.id);
        let referenceImageIndex: number | undefined;
        if (ref && refs.length < MAX_REFERENCES) {
          refs.push({
            asset: ref,
            role: "prop_ref",
            label: `${pr.p.name} v${pr.v.versionNumber}`,
            subjectVersionId: pr.v.id,
          });
          referenceImageIndex = refs.length;
        }
        propCtx.push({
          name: pr.p.name,
          description: pr.v.description,
          referenceImageIndex,
          referenceKind: referenceImageIndex ? ref?.referenceKind : undefined,
        });
      }
    }

    if (styleRef && refs.length < MAX_REFERENCES) {
      refs.push({ asset: styleRef, role: "style_ref", label: "project style", subjectVersionId: null });
      style.hasStyleReference = refs.length;
    }

    const scene = panel.sceneId
      ? ((await this.db.select().from(scenes).where(eq(scenes.id, panel.sceneId)))[0] ?? null)
      : null;
    const continuity: string[] = [];
    if (scene) {
      continuity.push(...scene.continuityNotes, ...Object.entries(scene.initialState).map(([k, v]) => `${k}: ${v}`));
      const cast = await this.db
        .select({ name: characters.name, key: characters.analysisKey })
        .from(characters)
        .where(eq(characters.projectId, panel.projectId));
      const present = new Set(chars.map((c) => c.name.toLowerCase()));
      // A note about someone not in this panel is left out; a note about no one in particular is kept.
      const relevant = (note: string) => {
        const l = note.toLowerCase();
        const mentions = cast.filter(
          (c) => l.includes(c.name.toLowerCase()) || (c.key && l.includes(c.key.toLowerCase())),
        );
        return !mentions.length || mentions.some((m) => present.has(m.name.toLowerCase()));
      };
      // What earlier scenes of the chapter changed for good (a torn sleeve, a bandaged hand) still shows here, and
      // a scene that states no starting state of its own starts where the one before it ended.
      const before = await this.db
        .select()
        .from(scenes)
        .where(and(eq(scenes.chapterId, scene.chapterId), sql`${scenes.order} < ${scene.order}`))
        .orderBy(asc(scenes.order));
      const last = before.at(-1);
      if (last && !Object.keys(scene.initialState).length)
        continuity.push(
          ...Object.entries(last.finalState)
            .map(([k, v]) => `${k}: ${v}`)
            .filter(relevant),
        );
      continuity.push(...before.flatMap((b) => b.continuityDeltas).filter(relevant));
      // continuity from earlier panels in the same scene, filtered to present characters
      const earlier = await this.db
        .select({ spec: panelSpecs.spec, order: panels.order, pageOrder: pages.order, id: panels.id })
        .from(panels)
        .innerJoin(pages, eq(pages.id, panels.pageId))
        .innerJoin(panelSpecs, eq(panelSpecs.panelId, panels.id))
        .where(eq(panels.sceneId, scene.id));
      for (const e of earlier) {
        if (e.pageOrder > page.order || (e.pageOrder === page.order && e.order >= panel.order)) continue;
        continuity.push(...(e.spec.continuityRequirements ?? []).filter(relevant));
      }
    }

    let previousPanelImageIndex: number | undefined;
    if (opts.includePreviousPanel !== false && panel.sceneId && refs.length < MAX_REFERENCES) {
      const prev = await this.previousPanelArtwork(panel.sceneId, page.order, panel.order);
      if (prev) {
        refs.push({
          asset: prev,
          role: "previous_panel",
          label: "previous panel (continuity only)",
          subjectVersionId: null,
        });
        previousPanelImageIndex = refs.length;
      }
    }

    const draft = (panel.promptDraft ?? null) as PanelPromptInput["draft"];
    const input: PanelPromptInput = {
      style,
      scene: scene ? { title: scene.title, summary: scene.summary, time: scene.time, weather: scene.weather } : null,
      panel: {
        storyBeat: panel.storyBeat,
        shotType: panel.shotType,
        cameraAngle: panel.cameraAngle,
        aspectRatio: aspectRatioOf(panel.frame, page.width, page.height),
        spec,
      },
      characters: chars,
      location,
      props: propCtx,
      previousPanelImageIndex,
      continuity: [...new Set(continuity)].slice(0, 12),
      reserveTextSpace: await this.panelHasLettering(panel.id),
      film: settings.format === "film",
      draft,
    };
    return { panel, page, project, settings, input, refs, compiledPrompt: panelGenerationV1.compile(input) };
  }

  private async panelHasLettering(panelId: string) {
    const [r] = await this.db.execute<{ has: boolean }>(sql`
      select exists (select 1 from dialogue_lines where panel_id = ${panelId})
        or exists (select 1 from narration_lines where panel_id = ${panelId} and show_on_page) as has`);
    return Boolean(r?.has);
  }

  private async previousPanelArtwork(sceneId: string, pageOrder: number, panelOrder: number) {
    const rows = await this.db
      .select({ panel: panels, pageOrder: pages.order })
      .from(panels)
      .innerJoin(pages, eq(pages.id, panels.pageId))
      .where(eq(panels.sceneId, sceneId))
      .orderBy(desc(pages.order), desc(panels.order));
    const prev = rows.find(
      (r) =>
        r.panel.activeArtworkAssetId &&
        (r.pageOrder < pageOrder || (r.pageOrder === pageOrder && r.panel.order < panelOrder)),
    );
    return prev?.panel.activeArtworkAssetId ? this.assetsSvc.get(prev.panel.activeArtworkAssetId) : null;
  }

  /**
   * `ai` is the caller's own picked key, so the inspector names the model that a generation started right now
   * would use. Resolution failures (no key chosen yet, key deleted) leave the model blank rather than failing a
   * read-only preview.
   */
  async previewPanel(panelId: string, ai?: AiChoice | null, userId?: string | null) {
    const ctx = await this.panelContext(panelId);
    const run = await this.imageRun(ai, userId ?? null).catch(() => null);
    return {
      template: { name: panelGenerationV1.name, version: panelGenerationV1.version },
      compiledPrompt: ctx.panel.promptOverride?.trim() ? ctx.panel.promptOverride : ctx.compiledPrompt,
      generatedPrompt: ctx.compiledPrompt,
      usesOverride: Boolean(ctx.panel.promptOverride?.trim()),
      aspectRatio: ctx.input.panel.aspectRatio,
      references: ctx.refs.map((r, i) => ({
        index: i + 1,
        role: r.role,
        label: r.label,
        assetId: r.asset.id,
        canonicalWidth: r.asset.width,
        canonicalHeight: r.asset.height,
        subjectVersionId: r.subjectVersionId,
      })),
      characters: ctx.input.characters.map((c) => ({
        name: c.name,
        versionNumber: c.versionNumber,
        hasReference: Boolean(c.referenceImageIndex),
      })),
      provider: run?.provider ?? this.image?.provider ?? "",
      model: run?.model ?? this.image?.model ?? "",
      quality: ctx.settings.imageQuality ?? this.image?.quality ?? "low",
    };
  }

  async enqueuePanel(
    panelId: string,
    userId: string | null,
    opts: {
      priority: number;
      batchId?: string | null;
      promptOverride?: string | null;
      regenerationOf?: string | null;
      operation?: string | null;
      ai?: AiChoice | null;
      /** The caller confirmed going over the project budget; the worker must not pause this job for it. */
      allowOverBudget?: boolean;
      /**
       * Part of a provider-batch run: the job is written but not queued, so nothing generates it synchronously
       * while the batch submitter collects it. `batchMode` also keeps the queue reconciler from republishing it.
       */
      batchMode?: boolean;
    },
  ) {
    const run = await this.imageRun(opts.ai, userId);
    const ctx = await this.panelContext(panelId);
    const override = opts.promptOverride ?? ctx.panel.promptOverride;
    const prompt = override?.trim() ? override : ctx.compiledPrompt;
    const inputs: NewGenerationInput[] = [];
    for (const r of ctx.refs)
      inputs.push(await this.derivativeInput(r.asset, r.role, r.label, r.subjectVersionId, ctx.settings, run.provider));
    const size = this.sizeString(ctx.input.panel.aspectRatio);
    const job = await this.db.transaction(async (tx) => {
      const j = await this.jobs.createGenerationJob(
        tx,
        {
          projectId: ctx.panel.projectId,
          userId,
          kind: "panel_generation",
          priority: opts.priority,
          batchId: opts.batchId,
          targetType: "panel",
          targetId: panelId,
          templateName: override?.trim() ? "panel-generation-user-edited" : panelGenerationV1.name,
          templateVersion: panelGenerationV1.version,
          compiledPrompt: prompt,
          provider: run.provider,
          model: run.model,
          parameters: {
            ai: run.ai,
            quality: ctx.settings.imageQuality ?? this.image?.quality ?? "low",
            aspectRatio: ctx.input.panel.aspectRatio,
            requestedSize: size,
            referenceCount: inputs.length,
            regenerationOf: opts.regenerationOf ?? null,
            operation: opts.operation ?? null,
            parentAssetId: ctx.panel.activeArtworkAssetId,
            ...(opts.allowOverBudget ? { allowOverBudget: true } : {}),
            ...(opts.batchMode ? { batchMode: true } : {}),
          },
          input: {
            pageId: ctx.page.id,
            characterVersionIds: ctx.panel.characterVersionIds,
            locationVersionId: ctx.panel.locationVersionId,
            propVersionIds: ctx.panel.propVersionIds,
            styleId: (await this.styleContext(ctx.panel.projectId)).styleId,
            promptInput: ctx.input,
          },
          inputs,
        },
        { enqueue: !opts.batchMode },
      );
      await tx.update(panels).set({ status: "queued" }).where(eq(panels.id, panelId));
      return j;
    });
    return job;
  }

  private sizeString(aspect: number) {
    return `ar:${aspect.toFixed(3)}`;
  }

  async enqueueReference(
    subject: "character" | "location" | "prop" | "style",
    versionId: string,
    kind: ReferenceKind,
    userId: string | null,
    opts: {
      extraInstruction?: string;
      outfitId?: string | null;
      ai?: AiChoice | null;
      /** A bulk run: the jobs share a batch id, so they are tracked, paused and cancelled together. */
      batchId?: string | null;
      priority?: number;
      /** The caller confirmed going over the project budget; the worker must not pause this job for it. */
      allowOverBudget?: boolean;
      /** Written but not queued, for the provider-batch submitter to collect — exactly as a batched panel is. */
      batchMode?: boolean;
    } = {},
  ) {
    const run = await this.imageRun(opts.ai, userId);
    let projectId: string;
    let prompt: string;
    let label: string;
    let templateName: string;
    let templateVersion: number;
    /** The approved identity reference an outfit reference is drawn from. */
    let baseline: AssetRecord | null = null;
    const input: Record<string, unknown> = { subject, versionId, kind, outfitId: opts.outfitId ?? null };
    if (subject === "character") {
      const [r] = await this.db
        .select({ v: characterVersions, c: characters })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(eq(characterVersions.id, versionId));
      if (!r) throw new PlanningError(404, "Character version not found");
      if (r.v.status === "superseded")
        throw new PlanningError(409, "Cannot generate references for a superseded version");
      projectId = r.c.projectId;
      const { style } = await this.styleContext(projectId);
      const bible = CharacterBible.parse(r.v.description);
      const refKind = (
        ["portrait", "full_body", "multi_angle", "expression_sheet", "outfit"].includes(kind) ? kind : "portrait"
      ) as "portrait";
      let outfit: { name: string; description: string } | null = null;
      if (opts.outfitId) {
        const [o] = await this.db.select().from(characterOutfits).where(eq(characterOutfits.id, opts.outfitId));
        if (!o) throw new PlanningError(404, "Outfit not found");
        if (o.characterId !== r.c.id) throw new PlanningError(400, "That outfit belongs to another character");
        outfit = { name: o.name, description: o.description };
      }
      // An outfit reference re-dresses the approved design rather than inventing the character again: without a
      // baseline, each outfit would drift into a different face and build, which is the thing references exist
      // to prevent.
      if (kind === "outfit") {
        baseline = await this.approvedReference("character", versionId);
        if (!baseline)
          throw new PlanningError(
            409,
            "Generate and approve this character's main reference first — an outfit reference is drawn from it so the face and build stay identical.",
          );
      }
      prompt = characterReferenceV1.compile({
        style,
        name: r.c.name,
        role: r.c.role,
        bible,
        immutableTraits: r.v.immutableTraits,
        kind: refKind,
        outfit,
        fromBaseline: Boolean(baseline),
        extraInstruction: opts.extraInstruction,
      });
      label = `${r.c.name} v${r.v.versionNumber} ${kind}`;
      templateName = characterReferenceV1.name;
      templateVersion = characterReferenceV1.version;
    } else if (subject === "location") {
      const [r] = await this.db
        .select({ v: locationVersions, l: locations })
        .from(locationVersions)
        .innerJoin(locations, eq(locations.id, locationVersions.locationId))
        .where(eq(locationVersions.id, versionId));
      if (!r) throw new PlanningError(404, "Location version not found");
      projectId = r.l.projectId;
      const { style } = await this.styleContext(projectId);
      kind = kind === "location_panorama" || kind === "location_sheet" ? kind : "location";
      prompt = locationReferenceV1.compile({
        style,
        name: r.l.name,
        description: r.v.description,
        kind,
        extraInstruction: opts.extraInstruction,
      });
      label = `${r.l.name} v${r.v.versionNumber}${kind === "location" ? "" : ` ${kind.replace("location_", "")}`}`;
      templateName = locationReferenceV1.name;
      templateVersion = locationReferenceV1.version;
    } else if (subject === "prop") {
      const [r] = await this.db
        .select({ v: propVersions, p: props })
        .from(propVersions)
        .innerJoin(props, eq(props.id, propVersions.propId))
        .where(eq(propVersions.id, versionId));
      if (!r) throw new PlanningError(404, "Prop version not found");
      projectId = r.p.projectId;
      const { style } = await this.styleContext(projectId);
      kind = kind === "prop_multi_angle" ? kind : "prop";
      prompt = propReferenceV1.compile({
        style,
        name: r.p.name,
        description: r.v.description,
        kind,
        extraInstruction: opts.extraInstruction,
      });
      label = `${r.p.name} v${r.v.versionNumber}${kind === "prop" ? "" : " multi angle"}`;
      templateName = propReferenceV1.name;
      templateVersion = propReferenceV1.version;
    } else {
      const [ps] = await this.db.select().from(projectStyles).where(eq(projectStyles.id, versionId));
      if (!ps) throw new PlanningError(404, "Project style not found");
      projectId = ps.projectId;
      const { style } = await this.styleContext(projectId);
      prompt = styleReferenceV1.compile({ style, subject: opts.extraInstruction ?? "" });
      label = "style reference";
      templateName = styleReferenceV1.name;
      templateVersion = styleReferenceV1.version;
      kind = "style";
    }
    input.sourceFingerprint = await versionFingerprint(this.db, subject, versionId);
    const project = await this.project(projectId);
    const aspectRatio = REFERENCE_ASPECT[kind] ?? 1;
    const inputs: NewGenerationInput[] = baseline
      ? [
          await this.derivativeInput(
            baseline,
            "character_ref",
            "approved character design",
            versionId,
            project.settings,
            run.provider,
          ),
        ]
      : [];
    const job = await this.db.transaction((tx) =>
      this.jobs.createGenerationJob(
        tx,
        {
          projectId,
          userId,
          kind: `${subject}_reference` as "character_reference",
          priority: opts.priority ?? 2,
          batchId: opts.batchId ?? null,
          targetType: `${subject}_version`,
          targetId: versionId,
          templateName,
          templateVersion,
          compiledPrompt: prompt,
          provider: run.provider,
          model: run.model,
          parameters: {
            ai: run.ai,
            quality: project.settings.imageQuality ?? this.image?.quality ?? "low",
            aspectRatio,
            referenceKind: kind,
            label,
            fullResolution: true,
            ...(opts.allowOverBudget ? { allowOverBudget: true } : {}),
            ...(opts.batchMode ? { batchMode: true } : {}),
          },
          input,
          inputs,
        },
        { enqueue: !opts.batchMode },
      ),
    );
    return job;
  }

  async enqueueEdit(
    panelId: string,
    userId: string | null,
    a: {
      maskAssetId: string;
      instruction: string;
      operation?: string | null;
      sourceAssetId?: string | null;
      ai?: AiChoice | null;
    },
  ) {
    const run = await this.imageRun(a.ai, userId);
    const ctx = await this.panelContext(panelId, { includePreviousPanel: false });
    const targetId = a.sourceAssetId ?? ctx.panel.activeArtworkAssetId;
    if (!targetId) throw new PlanningError(409, "Panel has no artwork to edit");
    const target = await this.assetsSvc.get(targetId);
    const mask = await this.assetsSvc.get(a.maskAssetId);
    if (!target || target.projectId !== ctx.panel.projectId) throw new PlanningError(404, "Artwork not found");
    if (!mask || mask.projectId !== ctx.panel.projectId || mask.type !== "panel_mask")
      throw new PlanningError(404, "Mask not found");
    // Target and mask are FULL resolution; only auxiliary identity references are small derivatives.
    const inputs: NewGenerationInput[] = [
      {
        role: "target",
        assetId: target.id,
        label: "current panel (full resolution)",
        width: target.width,
        height: target.height,
        metadata: { fullResolution: true },
      },
      {
        role: "mask",
        assetId: mask.id,
        label: "edit mask (full resolution)",
        width: mask.width,
        height: mask.height,
        metadata: { fullResolution: true },
      },
    ];
    const charRefs = ctx.refs.filter((r) => r.role !== "previous_panel");
    const editChars: { name: string; referenceImageIndex?: number; immutableTraits: string[] }[] = [];
    for (const r of charRefs) {
      inputs.push(await this.derivativeInput(r.asset, r.role, r.label, r.subjectVersionId, ctx.settings, run.provider));
    }
    for (const c of ctx.input.characters) {
      const idx = charRefs.findIndex((r) => r.label.startsWith(`${c.name} v`));
      // image 1 is the target, so auxiliary references start at image 2
      editChars.push({
        name: c.name,
        referenceImageIndex: idx >= 0 ? idx + 2 : undefined,
        immutableTraits: c.immutableTraits,
      });
    }
    const prompt = panelEditV1.compile({
      instruction: a.instruction,
      operation: a.operation ?? undefined,
      characters: editChars,
      style: ctx.input.style,
    });
    return this.db.transaction(async (tx) => {
      const j = await this.jobs.createGenerationJob(tx, {
        projectId: ctx.panel.projectId,
        userId,
        kind: "panel_edit",
        priority: 1,
        targetType: "panel",
        targetId: panelId,
        templateName: panelEditV1.name,
        templateVersion: panelEditV1.version,
        compiledPrompt: prompt,
        provider: run.provider,
        model: run.model,
        parameters: {
          ai: run.ai,
          quality: ctx.settings.imageQuality ?? this.image?.quality ?? "low",
          parentAssetId: target.id,
          operation: a.operation ?? "masked_edit",
          instruction: a.instruction,
        },
        input: { pageId: ctx.page.id, characterVersionIds: ctx.panel.characterVersionIds },
        inputs,
      });
      await tx.update(panels).set({ status: "queued" }).where(eq(panels.id, panelId));
      return j;
    });
  }

  async enqueueCover(
    projectId: string,
    userId: string | null,
    c: { title: string; subtitle: string; composition: string; characterIds: string[]; ai?: AiChoice | null },
  ) {
    const run = await this.imageRun(c.ai, userId);
    const project = await this.project(projectId);
    const { style, styleRef } = await this.styleContext(projectId);
    const chars = c.characterIds.length
      ? await this.db
          .select({ c: characters, v: characterVersions })
          .from(characters)
          .innerJoin(characterVersions, eq(characterVersions.id, characters.currentVersionId))
          .where(and(eq(characters.projectId, projectId), inArray(characters.id, c.characterIds)))
      : [];
    const inputs: NewGenerationInput[] = [];
    const promptChars: { name: string; appearance: string; referenceImageIndex?: number }[] = [];
    for (const { c: ch, v } of chars) {
      const ref = await this.approvedReference("character", v.id);
      if (ref)
        inputs.push(
          await this.derivativeInput(
            ref,
            "character_ref",
            `${ch.name} v${v.versionNumber}`,
            v.id,
            project.settings,
            run.provider,
          ),
        );
      const b = CharacterBible.parse(v.description);
      promptChars.push({
        name: ch.name,
        appearance: [b.hair, b.eyes, b.wardrobe].filter(Boolean).join(", "),
        referenceImageIndex: ref ? inputs.length : undefined,
      });
    }
    if (styleRef)
      inputs.push(
        await this.derivativeInput(styleRef, "style_ref", "project style", null, project.settings, run.provider),
      );
    const summary = project.description;
    const prompt = coverV1.compile({
      style,
      title: c.title,
      subtitle: c.subtitle,
      summary,
      composition: c.composition,
      characters: promptChars,
    });
    return this.db.transaction((tx) =>
      this.jobs.createGenerationJob(tx, {
        projectId,
        userId,
        kind: "cover",
        priority: 2,
        targetType: "project",
        targetId: projectId,
        templateName: coverV1.name,
        templateVersion: coverV1.version,
        compiledPrompt: prompt,
        provider: run.provider,
        model: run.model,
        parameters: {
          ai: run.ai,
          quality: project.settings.imageQuality ?? this.image?.quality ?? "low",
          aspectRatio: 2 / 3,
          title: c.title,
          subtitle: c.subtitle,
        },
        input: { characterIds: c.characterIds },
        inputs,
      }),
    );
  }

  /** Ordered panel ids for page/scene/chapter bulk generation. */
  async panelIdsFor(scope: { pageId?: string; sceneId?: string; chapterId?: string; panelIds?: string[] }) {
    if (scope.panelIds) return scope.panelIds;
    const q = this.db.select({ id: panels.id }).from(panels).innerJoin(pages, eq(pages.id, panels.pageId));
    const rows = scope.pageId
      ? await q.where(eq(panels.pageId, scope.pageId)).orderBy(asc(pages.order), asc(panels.order))
      : scope.sceneId
        ? await q.where(eq(panels.sceneId, scope.sceneId)).orderBy(asc(pages.order), asc(panels.order))
        : await q
            .where(eq(pages.chapterId, scope.chapterId ?? "00000000-0000-0000-0000-000000000000"))
            .orderBy(asc(pages.order), asc(panels.order));
    return rows.map((r) => r.id);
  }
}
