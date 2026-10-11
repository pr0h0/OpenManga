import { and, type DbOrTx, eq, promptOverrides } from "@openmanga/db";

/** The project's active rules for a built-in prompt, or null for the built-in one. */
export async function activeOverride(db: DbOrTx, projectId: string, templateName: string) {
  const [o] = await db
    .select()
    .from(promptOverrides)
    .where(
      and(
        eq(promptOverrides.projectId, projectId),
        eq(promptOverrides.templateName, templateName),
        eq(promptOverrides.active, true),
      ),
    )
    .limit(1);
  return o ?? null;
}
