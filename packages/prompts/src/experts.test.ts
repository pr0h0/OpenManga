import { expect, test } from "bun:test";
import { BUILTIN_EXPERTS, expertChatV2, findBuiltinExpert, splitImagePrompt } from "./experts.ts";

test("only the image prompt's own line goes to the image generator", () => {
  // Overlay text written after the prompt stays in the reply instead of being drawn.
  expect(
    splitImagePrompt("Concept A.\n\nIMAGE PROMPT: a keeper on the rocks at night\n\nTEXT OVERLAY: LUCK -99"),
  ).toEqual({
    text: "Concept A.\n\nTEXT OVERLAY: LUCK -99",
    imagePrompt: "a keeper on the rocks at night",
  });
  // A bold marker on its own line: the prompt is the paragraph after it.
  expect(
    splitImagePrompt("Pick B.\n\n**IMAGE PROMPT:**\nclose-up of a hero lit by a burning letter\n\nNotes after."),
  ).toEqual({
    text: "Pick B.\n\nNotes after.",
    imagePrompt: "close-up of a hero lit by a burning letter",
  });
  expect(splitImagePrompt("No image here.")).toEqual({ text: "No image here.", imagePrompt: null });
});

test("the v2 frame sets the language, says the project is a summary, and binds the art style", () => {
  const [system] = expertChatV2.build({
    expertPrompt: "You are a test expert.",
    project: { title: "Vell", language: "ko" },
    wantImage: true,
    history: [{ role: "user", content: "hi" }],
  });
  const text = system!.content;
  expect(text.startsWith("[template:expert-chat-v2]")).toBe(true);
  expect(text).toContain("project_data.language");
  expect(text).toContain("It is a SUMMARY");
  expect(text).toContain("project_data.artStyle");
  expect(text).toContain("Make the LAST line of your reply");
  expect(text).toContain("YOUR ROLE:\nYou are a test expert.");
});

test("the built-in experts carry the audit's fixes", () => {
  const prompt = (key: string) => findBuiltinExpert(key)!.systemPrompt;
  expect(prompt("thumbnail-designer")).toContain("write its image prompt for your PRIMARY PICK");
  expect(prompt("thumbnail-designer")).toContain("must be the last line of the reply");
  expect(prompt("character-designer")).toContain("APP FORMAT");
  expect(prompt("character-designer")).toContain("draw one clear view");
  expect(prompt("world-builder")).toContain("APP FORMAT");
  expect(prompt("beta-reader")).toContain("reading a summary is not reading the chapter");
  expect(prompt("channel-strategist")).toContain("You cannot browse");
  expect(prompt("channel-strategist")).not.toContain("Verify current platform information");
  expect(BUILTIN_EXPERTS).toHaveLength(10);
});
