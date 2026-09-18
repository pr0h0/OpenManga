import { AuthService } from "@openmanga/auth";
import type { AppConfig } from "@openmanga/config";
import {
  and,
  type Database,
  eq,
  promptTemplates,
  promptVersions,
  providerRateSnapshots,
  stylePresets,
  users,
} from "@openmanga/db";
import { BATCH_RATE_SNAPSHOTS, BUILTIN_STYLE_PRESETS, DEFAULT_RATE_SNAPSHOTS } from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import { allTemplateRecords } from "@openmanga/prompts";

/** Idempotent reference-data sync: prompt templates, style presets, rate snapshots, optional initial admin. */
export async function bootstrapReferenceData(db: Database, config: AppConfig, logger?: Logger) {
  for (const t of allTemplateRecords()) {
    const [tpl] = await db
      .insert(promptTemplates)
      .values({ name: t.name, kind: t.kind, description: t.description })
      .onConflictDoUpdate({ target: promptTemplates.name, set: { description: t.description } })
      .returning();
    const [existing] = await db
      .select()
      .from(promptVersions)
      .where(and(eq(promptVersions.templateId, tpl!.id), eq(promptVersions.version, t.version)));
    if (!existing)
      await db
        .insert(promptVersions)
        .values({ templateId: tpl!.id, version: t.version, body: t.body, sha256: t.sha256 });
    else if (existing.sha256 !== t.sha256) {
      logger?.warn("prompt template body changed without a version bump", { template: t.name, version: t.version });
      await db.update(promptVersions).set({ body: t.body, sha256: t.sha256 }).where(eq(promptVersions.id, existing.id));
    }
  }

  for (const p of BUILTIN_STYLE_PRESETS) {
    await db
      .insert(stylePresets)
      .values({ key: p.key, name: p.name, isBuiltin: true, definition: p.definition })
      .onConflictDoUpdate({ target: stylePresets.key, set: { name: p.name, definition: p.definition } });
  }

  const existingRates = await db.select().from(providerRateSnapshots);
  for (const r of [...DEFAULT_RATE_SNAPSHOTS, ...BATCH_RATE_SNAPSHOTS]) {
    if (existingRates.some((e) => e.provider === r.provider && e.model === r.model)) continue;
    await db.insert(providerRateSnapshots).values({
      provider: r.provider,
      model: r.model,
      effectiveFrom: new Date(r.effectiveFrom),
      textInputRate: String(r.textInputRate),
      cachedInputRate: String(r.cachedInputRate),
      textOutputRate: String(r.textOutputRate),
      imageInputRate: String(r.imageInputRate),
      imageOutputRate: String(r.imageOutputRate),
      imageUnitRate: String(r.imageUnitRate ?? 0),
      characterRate: String(r.characterRate ?? 0),
      metadata: {
        source: "seed-default",
        note: "Verify against provider pricing and add a new snapshot when prices change.",
      },
    });
  }

  if (config.INITIAL_ADMIN_USERNAME && config.INITIAL_ADMIN_EMAIL && config.INITIAL_ADMIN_PASSWORD) {
    const [exists] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, config.INITIAL_ADMIN_USERNAME.toLowerCase()));
    if (!exists) {
      const auth = new AuthService(db, { secret: config.SESSION_SECRET, sessionTtlDays: config.SESSION_TTL_DAYS });
      await auth.createUser(
        {
          username: config.INITIAL_ADMIN_USERNAME,
          email: config.INITIAL_ADMIN_EMAIL,
          password: config.INITIAL_ADMIN_PASSWORD,
        },
        "admin",
      );
      logger?.info("initial admin created", { username: config.INITIAL_ADMIN_USERNAME });
    }
  }
}
