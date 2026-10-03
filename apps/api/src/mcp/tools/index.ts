import type { McpTool } from "../registry.ts";
import { bibleTools } from "./bible.ts";
import { chapterTools } from "./chapters.ts";
import { commentTools } from "./comments.ts";
import { expertTools } from "./experts.ts";
import { exportTools } from "./exports.ts";
import { generationTools } from "./generations.ts";
import { imageTools } from "./images.ts";
import { libraryTools } from "./library.ts";
import { narrationTools } from "./narration.ts";
import { panelTools } from "./panels.ts";
import { productionTools } from "./production.ts";
import { projectTools } from "./projects.ts";
import { storyTools } from "./stories.ts";
import { systemTools } from "./system.ts";

/** Every MCP tool, in catalogue order. The one list the server, the approval engine and the docs read. */
export const MCP_TOOLS = [
  ...systemTools,
  ...projectTools,
  ...storyTools,
  ...bibleTools,
  ...libraryTools,
  ...chapterTools,
  ...panelTools,
  ...commentTools,
  ...imageTools,
  ...generationTools,
  ...narrationTools,
  ...exportTools,
  ...productionTools,
  ...expertTools,
] as unknown as McpTool[];
