import { expect, test } from "bun:test";
import { buildLabel } from "./build.ts";

test("a build is labelled by version and UTC build time to the second", () => {
  expect(buildLabel({ version: "0.5.0", builtAt: "2026-09-23T12:15:30.123Z", sha: "abc1234" })).toBe(
    "v0.5.0.20260923121530",
  );
  expect(buildLabel({ version: "0.5.0", builtAt: "2026-09-23T12:15:30Z", sha: null })).toBe("v0.5.0.20260923121530");
});

test("a dev checkout says so instead of pretending to a build time", () => {
  expect(buildLabel({ version: "0.5.0", builtAt: null, sha: null })).toBe("v0.5.0-dev");
});

test("the package version is the newest release in the changelog", async () => {
  // The header label starts with this number, so a release that forgets to bump it would ship claiming to be the
  // previous one. The changelog is where a release is written down first; the version has to agree with it.
  const root = new URL("../../../", import.meta.url);
  const pkg = (await Bun.file(new URL("package.json", root)).json()) as { version: string };
  const changelog = await Bun.file(new URL("CHANGELOG.md", root)).text();
  const newest = changelog.match(/^## \[(\d+\.\d+\.\d+)\]/m)?.[1];
  expect(pkg.version).toBe(newest!);
});
