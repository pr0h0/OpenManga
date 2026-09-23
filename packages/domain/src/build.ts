/** Where a running build came from: stamped into each image at build time, so a deploy can say what it is. */
export type BuildInfo = {
  version: string;
  /** ISO time the image was built, or null for an unbuilt dev checkout. */
  builtAt: string | null;
  /** Short commit the build was made from, when the build was told it (the image has no .git to read). */
  sha: string | null;
};

/**
 * `v0.5.0.20260923121530`: the release version, then the UTC build time to the second. The version alone says
 * nothing between releases — master is deployed many times under one number — while the time orders every build
 * and matches against `git log` to tell what is and is not in it.
 */
export function buildLabel(b: BuildInfo) {
  if (!b.builtAt) return `v${b.version}-dev`;
  const stamp = b.builtAt.replace(/\.\d+Z$|Z$/, "").replace(/[-:T]/g, "");
  return `v${b.version}.${stamp}`;
}
