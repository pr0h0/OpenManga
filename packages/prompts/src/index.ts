import { createHash } from "node:crypto";
import { IMAGE_TEMPLATES } from "./image-templates.ts";
import { TEXT_TEMPLATES } from "./templates.ts";

export * from "./experts.ts";
export * from "./image-templates.ts";
export * from "./templates.ts";
export * from "./text-templates.ts";

export type TemplateRecord = {
  name: string;
  version: number;
  kind: "text" | "image";
  description: string;
  body: string;
  sha256: string;
};

/** Registry used to sync prompt_templates/prompt_versions rows. */
export function allTemplateRecords(): TemplateRecord[] {
  return [
    ...TEXT_TEMPLATES.map((t) => ({
      name: t.name,
      version: t.version,
      kind: "text" as const,
      description: t.description,
      body: t.system,
    })),
    ...IMAGE_TEMPLATES.map((t) => ({
      name: t.name,
      version: t.version,
      kind: "image" as const,
      description: t.description,
      body: t.body,
    })),
  ].map((t) => ({ ...t, sha256: createHash("sha256").update(t.body).digest("hex") }));
}
