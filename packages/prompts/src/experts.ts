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

/** The part of a reply's frame that is the same for every version: the role, the image request, the project. */
function frameFor(system: string, i: ExpertChatInput, imageRule: string) {
  const frame = [
    system,
    `YOUR ROLE:\n${i.expertPrompt.trim()}`,
    i.wantImage ? imageRule : "",
    i.project ? untrusted("project_data", JSON.stringify(i.project)) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const messages: ChatMessage[] = [{ role: "system", content: frame }];
  for (const m of i.history) messages.push({ role: m.role, content: m.content });
  return messages;
}

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
    return frameFor(
      this.system,
      i,
      `IMAGE: this reply comes with one generated image. End your reply with a single line that starts with "${EXPERT_IMAGE_MARKER}" followed by a complete, self-contained prompt for an image generator: the subject, composition, style, lighting and mood. The image is drawn from that line alone, so repeat anything it needs. Do not ask the generator to draw text or lettering.`,
    );
  },
});

/**
 * v2 says what v1 left to chance: which language to write in, that the project data is a summary (not the chapters
 * or the art), that the project's art style binds anything visual, and that named characters are drawn from their
 * references, so the image prompt should name them exactly.
 */
export const expertChatV2 = defineTextTemplate<ExpertChatInput>({
  name: "expert-chat",
  version: 2,
  description: "A reply from a brainstorming expert, optionally with a prompt for an image.",
  system: [
    templateHeader("expert-chat", 2),
    "You are one of the experts a comic and manhwa creator consults while developing a series. Your role follows. Answer in plain text: short paragraphs, and lists where they help. Be concrete and useful; ask a question only when the answer depends on it.",
    "LANGUAGE: reply in the language the user writes in. Anything meant for the project itself (titles, narration, descriptions, dialogue, tags) is written in project_data.language unless the user asks for another.",
    "PROJECT: when project_data is given it is the user's project. Build on it, keep to it, and point out where an idea would contradict it. It is a SUMMARY: the cast (name, role, a short summary, look and personality), places, props, world notes, the art style and each chapter's title and summary. It does not contain the chapters' text, scenes, panels, dialogue or any image. When a judgment needs that material, say what you are working from and ask the user to paste or attach it rather than presenting a summary-based guess as a reading.",
    "ART STYLE: project_data.artStyle is the project's established art direction. Designs and image prompts follow it unless the user asks for something else.",
    DATA_RULE,
  ].join("\n\n"),
  build(i) {
    return frameFor(
      this.system,
      i,
      `IMAGE: this reply comes with exactly one generated image. Make the LAST line of your reply a single line that starts with "${EXPERT_IMAGE_MARKER}" followed by a complete, self-contained prompt for an image generator: the subject, composition, style, lighting and mood. Only that line is sent to the generator, so repeat anything it needs, and put everything else (notes, overlay text, placement) before it. Do not ask the generator to draw text or lettering. Name project characters and places exactly as project_data names them: those with an approved reference image are drawn from it.`,
    );
  },
});

/**
 * Splits a reply into its text and the image prompt it wrote. Only the marker's own line is the prompt (or, when the
 * marker stands alone on its line, the paragraph after it); anything after that stays part of the reply, so notes or
 * overlay text written below the prompt never reach the image generator.
 */
export function splitImagePrompt(reply: string): { text: string; imagePrompt: string | null } {
  const at = reply.lastIndexOf(EXPERT_IMAGE_MARKER);
  if (at < 0) return { text: reply.trim(), imagePrompt: null };
  const clean = (s: string) => s.replace(/^[\s*_`"]+|[\s*_`"]+$/g, "").trim();
  const after = reply.slice(at + EXPERT_IMAGE_MARKER.length);
  const nl = after.indexOf("\n");
  let prompt = clean(nl < 0 ? after : after.slice(0, nl));
  let rest = nl < 0 ? "" : after.slice(nl + 1);
  if (!prompt) {
    // "IMAGE PROMPT:" on a line of its own: the prompt is the paragraph that follows.
    const body = rest.replace(/^\s*\n/, "");
    const end = body.search(/\n\s*\n/);
    prompt = clean(end < 0 ? body : body.slice(0, end));
    rest = end < 0 ? "" : body.slice(end);
  }
  // A stray marker left at the start of a bold line ("**IMAGE PROMPT:**") takes its asterisks with it.
  const before = reply
    .slice(0, at)
    .replace(/[\s*_`#]+$/, "")
    .trim();
  const text = [before, rest.trim()].filter(Boolean).join("\n\n");
  return { text, imagePrompt: prompt || null };
}
