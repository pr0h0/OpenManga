import { EXPERT_PROMPTS } from "./expert-prompts.ts";
import { type ChatMessage, DATA_RULE, defineTextTemplate, templateHeader, untrusted } from "./text-templates.ts";

/**
 * A built-in expert: a system prompt with a name, for brainstorming and developing a series outside any chapter.
 * `image` is what a reply's picture is for, when it has one: the chat offers "generate image" on by default when set,
 * at that aspect ratio.
 */
export type BuiltinExpert = {
  key: string;
  name: string;
  description: string;
  systemPrompt: string;
  starters: string[];
  image?: { byDefault: boolean; aspectRatio: number };
};

export const BUILTIN_EXPERTS: BuiltinExpert[] = [
  {
    key: "topic-scout",
    name: "Topic Scout",
    description: "Finds story ideas and premises with a strong hook, and says who they are for.",
    ...EXPERT_PROMPTS["topic-scout"]!,
  },
  {
    key: "title-doctor",
    name: "Title Doctor",
    description: "Titles for series, chapters and videos: curious, clear, and short enough to read at a glance.",
    ...EXPERT_PROMPTS["title-doctor"]!,
  },
  {
    key: "thumbnail-designer",
    name: "Thumbnail Designer",
    description: "Designs video thumbnails and writes the image prompt that draws them.",
    ...EXPERT_PROMPTS["thumbnail-designer"]!,
    image: { byDefault: true, aspectRatio: 16 / 9 },
  },
  {
    key: "story-developer",
    name: "Story Developer",
    description: "Turns a premise into arcs, conflicts and chapter outlines, and finds the holes.",
    ...EXPERT_PROMPTS["story-developer"]!,
  },
  {
    key: "character-designer",
    name: "Character Designer",
    description: "Designs characters that are drawable and memorable: look, outfits, personality and arc.",
    ...EXPERT_PROMPTS["character-designer"]!,
    image: { byDefault: false, aspectRatio: 2 / 3 },
  },
  {
    key: "world-builder",
    name: "World Builder",
    description: "Settings, rules, factions and places that feel lived in and can be drawn.",
    ...EXPERT_PROMPTS["world-builder"]!,
    image: { byDefault: false, aspectRatio: 3 / 2 },
  },
  {
    key: "hook-editor",
    name: "Hook & Pacing Editor",
    description: "Openings, cliffhangers and pacing that keep readers and viewers from leaving.",
    ...EXPERT_PROMPTS["hook-editor"]!,
  },
  {
    key: "narration-writer",
    name: "Narration Scriptwriter",
    description: "Voice-over scripts for recap videos: spoken, flowing, and paced for the ear.",
    ...EXPERT_PROMPTS["narration-writer"]!,
  },
  {
    key: "beta-reader",
    name: "Beta Reader",
    description: "An honest first reader: what worked, what confused, what bored.",
    ...EXPERT_PROMPTS["beta-reader"]!,
  },
  {
    key: "channel-strategist",
    name: "Channel Strategist",
    description: "Descriptions, tags, upload plans and series positioning for publishing.",
    ...EXPERT_PROMPTS["channel-strategist"]!,
  },
];

export const findBuiltinExpert = (key: string) => BUILTIN_EXPERTS.find((e) => e.key === key) ?? null;

export const EXPERT_IMAGE_MARKER = "IMAGE PROMPT:";

export type ExpertChatInput = {
  /** The chat's system prompt: the expert, as the user may have adjusted it for this chat. */
  expertPrompt: string;
  /** A compact summary of the project being talked about, if any. */
  project: Record<string, unknown> | null;
  /** The reply should end with a prompt for an image generator. */
  wantImage: boolean;
  /** The conversation so far, oldest first. Images are attached by the caller: message k+1 is history[k]. */
  history: { role: "user" | "assistant"; content: string }[];
};

/**
 * One reply in a chat with an expert. The expert's own prompt comes after a short frame that is the same for every
 * expert: plain answers, the project as data, and how to ask for an image.
 */
export const expertChatV1 = defineTextTemplate<ExpertChatInput>({
  name: "expert-chat",
  version: 1,
  description: "A reply from a brainstorming expert, optionally with a prompt for an image.",
  system: [
    templateHeader("expert-chat", 1),
    "You are one of the experts a comic and manhwa creator consults while developing a series. Your role follows. Answer in plain text: short paragraphs, and lists where they help. Be concrete and useful; ask a question only when the answer depends on it.",
    "When project_data is given it is the user's project (its cast, places and chapters). Build on it, keep to it, and point out where an idea would contradict it.",
    DATA_RULE,
  ].join("\n\n"),
  build(i) {
    const frame = [
      this.system,
      `YOUR ROLE:\n${i.expertPrompt.trim()}`,
      i.wantImage
        ? `IMAGE: this reply comes with one generated image. End your reply with a single line that starts with "${EXPERT_IMAGE_MARKER}" followed by a complete, self-contained prompt for an image generator: the subject, composition, style, lighting and mood. The image is drawn from that line alone, so repeat anything it needs. Do not ask the generator to draw text or lettering.`
        : "",
      i.project ? untrusted("project_data", JSON.stringify(i.project)) : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const messages: ChatMessage[] = [{ role: "system", content: frame }];
    for (const m of i.history) messages.push({ role: m.role, content: m.content });
    return messages;
  },
});

/** Splits a reply into its text and the image prompt it ended with, if it wrote one. */
export function splitImagePrompt(reply: string): { text: string; imagePrompt: string | null } {
  const at = reply.lastIndexOf(EXPERT_IMAGE_MARKER);
  if (at < 0) return { text: reply.trim(), imagePrompt: null };
  const imagePrompt = reply
    .slice(at + EXPERT_IMAGE_MARKER.length)
    .replace(/^[\s*_`]+|[\s*_`]+$/g, "")
    .trim();
  // A stray marker left at the start of a bold line ("**IMAGE PROMPT:**") takes its asterisks with it.
  const text = reply
    .slice(0, at)
    .replace(/[\s*_`]+$/, "")
    .trim();
  return { text, imagePrompt: imagePrompt || null };
}
