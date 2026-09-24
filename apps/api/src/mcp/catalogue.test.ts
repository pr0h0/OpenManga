import { expect, test } from "bun:test";
import { mcpCatalogueMarkdown } from "./catalogue.ts";
import { annotationsFor } from "./registry.ts";
import { ALL_SCOPES } from "./scopes.ts";
import { MCP_TOOLS } from "./tools/index.ts";

test("docs/MCP_TOOLS.md is up to date with the tool registry and scopes", async () => {
  const committed = await Bun.file(new URL("../../../../docs/MCP_TOOLS.md", import.meta.url)).text();
  // Regenerate with `bun scripts/mcp-docs.ts` when this fails: a tool, its schema or a scope changed.
  expect(committed).toBe(mcpCatalogueMarkdown());
});

test("every tool is well-formed", () => {
  const names = new Set<string>();
  for (const t of MCP_TOOLS) {
    expect(t.name).toMatch(/^[a-z][a-z_]*$/);
    expect(names.has(t.name)).toBe(false);
    names.add(t.name);
    expect(t.description.length).toBeGreaterThan(40);
    for (const s of t.scopes) expect(ALL_SCOPES).toContain(s);
    // Anything that is not a plain read must classify each call, or it could never be parked for approval.
    if (t.sensitivity !== "read") expect(t.classify).toBeDefined();
    if (t.sensitivity === "read") expect(annotationsFor(t).readOnlyHint).toBe(true);
    // Spending must say so to the model.
    if (t.sensitivity === "spend") expect(t.description).toMatch(/spend|credits/i);
  }
  // No generic escape hatches.
  for (const banned of ["call_api", "request", "execute_http", "sql"]) expect(names.has(banned)).toBe(false);
});

test("every scope is used by at least one tool", () => {
  for (const s of ALL_SCOPES) expect(MCP_TOOLS.some((t) => t.scopes.includes(s))).toBe(true);
});
