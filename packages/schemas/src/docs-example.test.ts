import { expect, test } from "bun:test";
import { join } from "node:path";
import { StoryAnalysis } from "./index.ts";

// The keyless guide shows people what to paste. An example that does not parse teaches them to paste something
// that will be rejected — and the first draft of this one did exactly that, with two fields written as strings
// that the schema defines as objects. So the example is held to the schema like any answer is.
test("the worked example in WITHOUT_API_KEYS.md is a valid StoryAnalysis", async () => {
  const doc = await Bun.file(join(import.meta.dir, "../../../docs/WITHOUT_API_KEYS.md")).text();
  const block = doc.match(/```json\n([\s\S]*?)```/)?.[1];
  expect(block).toBeTruthy();
  const parsed = StoryAnalysis.safeParse(JSON.parse(block!));
  expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
});
