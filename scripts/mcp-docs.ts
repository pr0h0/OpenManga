// Regenerates docs/MCP_TOOLS.md from the MCP tool registry and scope catalogue.
import { mcpCatalogueMarkdown } from "../apps/api/src/mcp/catalogue.ts";

await Bun.write(new URL("../docs/MCP_TOOLS.md", import.meta.url), mcpCatalogueMarkdown());
console.log("wrote docs/MCP_TOOLS.md");
