/**
 * The MCP scope catalogue: the single list the OAuth metadata, the consent screen, the token wizard, the tool
 * registry and the generated docs all read. Each description is what the user sees when granting it.
 */
export const MCP_SCOPES = {
  "projects:read": "View projects and project metadata.",
  "projects:write": "Change project settings, state and metadata.",
  "projects:create": "Create new projects.",
  "story:read": "Read story revisions and analyses.",
  "story:write": "Create and edit story revisions and apply story analyses.",
  "library:read": "Read characters, locations, props, styles and references.",
  "library:write": "Create and edit characters, world entities, versions, outfits, styles and references.",
  "chapters:read": "Read chapters, scenes, beats and pages.",
  "chapters:write": "Create, edit and re-plan chapters, scenes and pages.",
  "panels:read": "Read panel specs, prompts and artwork metadata.",
  "panels:write": "Create, edit and reorder panels, specs, outfits and lettering.",
  "generations:read": "Read AI job, batch, prompt and generation status.",
  "generations:run": "Start, retry, answer or control AI and image generation work (may spend your provider credits).",
  "narration:read": "Read narration text, segments, audio status and timelines.",
  "narration:write": "Edit narration and request synthesis.",
  "exports:read": "Read export status and files.",
  "exports:create": "Queue project exports.",
  "experts:use": "Read and use your expert chats.",
  "usage:read": "Read usage and cost information.",
} as const;

export type McpScope = keyof typeof MCP_SCOPES;
export const ALL_SCOPES = Object.keys(MCP_SCOPES) as McpScope[];
export const isScope = (s: string): s is McpScope => s in MCP_SCOPES;

/** Keeps only known scopes, deduplicated, in catalogue order. */
export const normalizeScopes = (scopes: Iterable<string>) => {
  const want = new Set(scopes);
  return ALL_SCOPES.filter((s) => want.has(s));
};
