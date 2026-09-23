import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type BuildInfo, buildLabel } from "@openmanga/domain";

/**
 * The build this process is running, read once. An image carries `build-info.json`, written when it was built; a
 * dev checkout has none, and reports its package version with no build time rather than inventing one.
 */
function readBuildInfo(root = process.cwd()): BuildInfo {
  try {
    return JSON.parse(readFileSync(join(root, "build-info.json"), "utf8")) as BuildInfo;
  } catch {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
    return { version: pkg.version ?? "0.0.0", builtAt: null, sha: null };
  }
}

const info = readBuildInfo();
export const build = { ...info, label: buildLabel(info) };
