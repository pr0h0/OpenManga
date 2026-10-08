import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { allTemplateRecords } from "./index.ts";

/**
 * A released template version never changes: its body (with the schema it embeds) is recorded once per install, and
 * jobs and usage refer to it by name and version. Changing a prompt means a new version. This file pins every
 * version's hash; a new version is added with `UPDATE_TEMPLATE_HASHES=1 bun test packages/prompts`, which never
 * rewrites an existing entry.
 */
const FILE = new URL("./template-hashes.json", import.meta.url);

test("no released template version's body changes", () => {
  const pinned = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, string>;
  const records = allTemplateRecords().map((r) => [`${r.kind}:${r.name}@${r.version}`, r.sha256] as const);
  const changed = records.filter(([k, sha]) => pinned[k] && pinned[k] !== sha).map(([k]) => k);
  expect(changed, `bump the version instead of editing: ${changed.join(", ")}`).toEqual([]);
  const added = records.filter(([k]) => !pinned[k]);
  if (added.length && process.env.UPDATE_TEMPLATE_HASHES === "1") {
    const next = { ...pinned, ...Object.fromEntries(added) };
    writeFileSync(FILE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort()), null, 2)}\n`);
  } else
    expect(
      added.map(([k]) => k),
      "new versions: run with UPDATE_TEMPLATE_HASHES=1 to pin them",
    ).toEqual([]);
});
