import type { ChapterPlan, NarrationDraft, PanelPromptDraft, StoryAnalysis } from "@openmanga/schemas";

const STOP = new Set(
  "The A An And But Or If When While Then He She They It His Her Their Its I We You Me My Our Your This That These Those There Here What Who Why How Where After Before As At By For From In Into Of On Onto Out Over To Under Up With Without Chapter Part Once Now Just Still Even Only Suddenly Finally Later Meanwhile Yes No Not Nothing Something Someone Everyone Everything Maybe Perhaps Mr Mrs Ms Dr Oh Ah Hey Well So".split(
    " ",
  ),
);

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "x";

export function extractTemplateName(system: string): string | null {
  return system.match(/\[template:([a-z0-9-]+-v\d+)\]/)?.[1] ?? null;
}

export function extractTagged(content: string, tag: string): string[] {
  const re = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`, "g");
  return [...content.matchAll(re)].map((m) => m[1] ?? "");
}

function splitChapters(story: string) {
  const parts = story
    .split(/^\s*(?:chapter|episode|part)\s+[\w\d]+[^\n]*$/gim)
    .map((s) => s.trim())
    .filter(Boolean);
  const titles = [...story.matchAll(/^\s*((?:chapter|episode|part)\s+[\w\d]+[^\n]*)$/gim)].map((m) => m[1]!.trim());
  if (parts.length <= 1) return [{ title: titles[0] ?? "Chapter 1", text: (parts[0] ?? story).trim() }];
  const offset = parts.length - titles.length;
  return parts.map((text, i) => ({ title: titles[i - offset] ?? `Chapter ${i + 1}`, text }));
}

const sentences = (t: string) =>
  (t.replace(/\s+/g, " ").match(/[^.!?]+[.!?]*["”]?/g) ?? [t]).map((s) => s.trim()).filter((s) => s.length > 1);

function findNames(story: string) {
  const counts = new Map<string, number>();
  for (const s of sentences(story)) {
    const words = s.match(/\b[A-Z][a-z]+(?:[- ][A-Z][a-z]+)*(?:-[a-z]+)?\b/g) ?? [];
    for (const w of words) {
      const first = w.split(/[- ]/)[0]!;
      if (STOP.has(first) || STOP.has(w)) continue;
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .map(([n]) => n);
}

const PLACE_RE =
  /\b(?:in|on|at|into|inside|onto|across|through)\s+(?:the|a|an)\s+((?:[a-z]+\s)?(?:rooftop|roof|hallway|classroom|room|bedroom|kitchen|street|alley|forest|castle|hall|office|hospital|station|school|library|park|bridge|apartment|cafe|shop|market|temple|throne room|cave|beach|city|village|house|car|train|bus|stairwell|staircase|gym|garden|tower|dungeon|guild hall|warehouse|bar|restaurant))\b/gi;

const PROP_RE =
  /\b(?:sword|ring|phone|amulet|gun|mask|helmet|artifact|necklace|book|letter|knife|staff|umbrella|key|watch|bracelet|bag|lantern)\b/gi;

const palettes = ["black", "dark brown", "silver", "chestnut", "ash blonde", "navy blue", "auburn", "white"];
const eyeColors = ["dark brown", "grey", "amber", "hazel", "black", "blue"];

/** Heuristic, deterministic stand-in for DeepSeek story analysis. */
export function mockStoryAnalysis(story: string): StoryAnalysis {
  const names = findNames(story).slice(0, 6);
  const lower = story.toLowerCase();
  const chars = (names.length ? names : ["Protagonist"]).map((name, i) => {
    const pronoun = new RegExp(`\\b${name}\\b[^.]*\\b(she|her)\\b`, "i").test(story) ? "female" : "male";
    return {
      key: slug(name),
      name,
      aliases: i === 0 ? [pronoun === "female" ? "she" : "he", pronoun === "female" ? "the girl" : "the boy"] : [],
      role: (i === 0 ? "protagonist" : i === names.length - 1 && names.length > 2 ? "antagonist" : "supporting") as
        | "protagonist"
        | "antagonist"
        | "supporting",
      bible: {
        genderPresentation: pronoun,
        ageRange: "late teens",
        height: i === 0 ? "average height" : "tall",
        build: i % 2 ? "athletic" : "slim",
        faceShape: i % 2 ? "square jaw" : "oval",
        skinTone: "light olive",
        eyes: `${eyeColors[i % eyeColors.length]} narrow eyes`,
        eyebrows: "straight, defined",
        nose: "straight",
        mouth: "thin lips",
        hair: `${palettes[i % palettes.length]} ${i % 2 ? "short cropped" : "shoulder-length messy"} hair`,
        facialHair: "",
        distinctiveFeatures: i === 0 ? ["small scar above left eyebrow"] : [],
        wardrobe: i === 0 ? "dark school uniform with rolled sleeves" : "casual dark jacket over a white shirt",
        accessories: [],
        weapons: [],
        props: [],
        personality: i === 0 ? "reserved, determined" : "confident",
        visualMannerisms: i === 0 ? "keeps hands in pockets" : "crosses arms",
        defaultExpression: "calm",
        immutableTraits: [`${palettes[i % palettes.length]} hair`, `${eyeColors[i % eyeColors.length]} eyes`],
        outfitVariants: [],
        summary: `${name}, ${pronoun === "female" ? "a young woman" : "a young man"} in the story.`,
      },
    };
  });

  const placeNames = [...new Set([...story.matchAll(PLACE_RE)].map((m) => m[1]!.toLowerCase()))].slice(0, 4);
  const locations = (placeNames.length ? placeNames : ["main setting"]).map((p) => ({
    key: slug(p),
    name: p.replace(/\b\w/g, (c) => c.toUpperCase()),
    description: {
      kind: p,
      architecture: "modern urban",
      layout: "open central area with a clear focal point",
      palette: "muted blues and greys",
      lighting: lower.includes("night") ? "cold night light with city glow" : "soft overcast daylight",
      atmosphere: lower.includes("rain") ? "wet, rainy, reflective surfaces" : "quiet",
      keyFeatures: [`recognizable ${p} features`],
      immutableTraits: [],
      summary: `The ${p} where key events happen.`,
    },
  }));

  const propNames = [...new Set([...story.matchAll(PROP_RE)].map((m) => m[0].toLowerCase()))].slice(0, 3);
  const chapters = splitChapters(story).map((c, i) => ({
    order: i + 1,
    title: c.title,
    summary: sentences(c.text).slice(0, 2).join(" ").slice(0, 300),
    sourceStart: c.text.split(/\s+/).slice(0, 12).join(" "),
    beats: sentences(c.text).slice(0, 5),
  }));

  return {
    title: story.split("\n")[0]!.slice(0, 60),
    summary: sentences(story).slice(0, 3).join(" ").slice(0, 500) || "A short story.",
    genre: lower.includes("sword") || lower.includes("magic") ? "fantasy" : "drama",
    subgenre: lower.includes("school") ? "school" : "urban",
    tone: lower.includes("rain") || lower.includes("night") ? "moody, tense" : "earnest",
    themes: ["identity", "courage"],
    setting: locations[0]!.name,
    period: "contemporary",
    pacing: "measured build to a tense ending",
    visualMotifs: lower.includes("rain") ? ["rain", "reflections"] : ["light and shadow"],
    protagonistKey: chars[0]!.key,
    characters: chars,
    relationships: chars.length > 1 ? [{ from: chars[0]!.key, to: chars[1]!.key, kind: "rival", notes: "" }] : [],
    locations,
    props: propNames.map((p) => ({
      key: slug(p),
      name: p.replace(/\b\w/g, (c) => c.toUpperCase()),
      recurring: true,
      description: {
        kind: p,
        material: "metal",
        size: "handheld",
        colors: "dark steel",
        keyFeatures: [],
        immutableTraits: [],
        summary: `An important ${p}.`,
      },
    })),
    world: {
      worldRules: [],
      factions: [],
      uniforms: [],
      technology: "modern",
      magicSystem: "",
      recurringScenery: [],
      vehicles: [],
      notes: "",
    },
    plotBeats: sentences(story)
      .slice(0, 6)
      .map((s, i) => ({
        order: i + 1,
        summary: s,
        characters: chars.filter((c) => s.includes(c.name)).map((c) => c.key),
        locationKey: "",
      })),
    chapters,
  };
}

type ProjectData = {
  characters?: { key: string; name: string; aliases?: string[] }[];
  locations?: { key: string; name: string }[];
  props?: { key: string; name: string }[];
};

const SHOTS = ["wide", "medium", "medium-close", "close", "full", "over-shoulder"] as const;
const ANGLES = ["eye-level", "low", "eye-level", "high", "over-shoulder", "eye-level"] as const;

/** Deterministic chapter plan: 1-2 scenes, 2 pages/scene, 3-4 panels/page, dialogue from quotes. */
const stripHeadings = (t: string) => t.replace(/^\s*(?:chapter|episode|part)\s+[\w\d]+[^\n]*$/gim, "");

const STRIP_HEIGHTS = ["normal", "short", "tall", "normal", "very-tall"] as const;
const STRIP_SEAMS = ["gap", "butt", "dissolve", "fade", "bleed"] as const;

export function mockChapterPlan(projectData: ProjectData, chapterText: string, templateKeys: string[]): ChapterPlan {
  const sents = sentences(stripHeadings(chapterText));
  const chars = projectData.characters ?? [];
  const locs = projectData.locations ?? [];
  const sceneCount = sents.length > 10 ? 2 : 1;
  const per = Math.ceil(sents.length / sceneCount) || 1;
  const pick = (n: number) =>
    templateKeys.includes(n === 3 ? "large-two-small" : "four-grid")
      ? n === 3
        ? "large-two-small"
        : "four-grid"
      : (templateKeys[0] ?? "");

  const scenes = Array.from({ length: sceneCount }, (_, si) => {
    const sceneSents = sents.slice(si * per, (si + 1) * per);
    const loc = locs[si % Math.max(1, locs.length)];
    const present = chars.filter((c) => sceneSents.some((s) => s.includes(c.name))).map((c) => c.key);
    const sceneChars = present.length ? present : chars.slice(0, 1).map((c) => c.key);
    const pages = [0, 1].map((pi) => {
      const count = pi === 0 ? 3 : 4;
      const panels = Array.from({ length: count }, (_, k) => {
        const s = sceneSents[(pi * 3 + k) % Math.max(1, sceneSents.length)] ?? "A quiet moment.";
        const quote = s.match(/["“]([^"”]+)["”]/)?.[1];
        const speaker = chars.find((c) => s.includes(c.name))?.key ?? sceneChars[0] ?? "";
        const inPanel = k === 0 && pi === 0 ? sceneChars : sceneChars.slice(0, Math.max(1, (k % 2) + 1));
        const shot = k === 0 && pi === 0 ? "wide" : SHOTS[(k + pi) % SHOTS.length]!;
        return {
          spec: {
            beat: s.replace(/["“”]/g, "").slice(0, 160),
            shotType: shot === "over-shoulder" ? "medium" : shot,
            cameraAngle: ANGLES[(k + pi) % ANGLES.length]!,
            characters: inPanel.map((key, ci) => ({
              characterId: key,
              expression: k % 2 ? "tense" : "focused",
              pose: ci === 0 ? "standing" : "turning",
              action: "",
              outfit: "",
              position: ci === 0 ? "right third" : "left third",
            })),
            locationId: loc?.key,
            composition: k === 0 ? "establishing view of the location" : "subject framed off-center",
            lighting: "",
            emotion: k % 2 ? "tension" : "resolve",
            action: s.slice(0, 120),
            continuityRequirements: [],
            negativeSpace: quote ? { area: "upper-left", purpose: "dialogue" as const } : undefined,
            propIds: [],
            dialogueIds: [],
            narrationIds: [],
            sfxIds: [],
            // Vertical strips read these; paged and film projects ignore them. Varied deterministically so a
            // test sees real pacing and real transitions rather than one repeated value.
            height: STRIP_HEIGHTS[(k + pi) % STRIP_HEIGHTS.length]!,
            seam: { kind: STRIP_SEAMS[(k + pi) % STRIP_SEAMS.length]! },
          },
          dialogue: quote
            ? [{ speaker, text: quote.slice(0, 120), kind: s.includes("!") ? ("shout" as const) : ("normal" as const) }]
            : [],
          narration: k === 0 && pi === 0 && !quote ? [s.slice(0, 140)] : [],
          sfx: /bang|crash|slam|boom/i.test(s) ? ["BAM"] : [],
        };
      });
      return {
        purpose: pi === 0 ? "establish scene" : "develop the moment",
        pacing: pi === 0 ? "slow" : "quickening",
        visualEmphasis: "",
        pageTurnHook: pi === 1 ? "unresolved tension" : "",
        layoutTemplate: pick(count),
        panels,
      };
    });
    return {
      title: `Scene ${si + 1}${loc ? ` — ${loc.name}` : ""}`,
      summary: sceneSents.slice(0, 2).join(" ").slice(0, 300),
      locationKey: loc?.key ?? "",
      time: /night/i.test(chapterText) ? "night" : "day",
      weather: /rain/i.test(chapterText) ? "rain" : "clear",
      characterKeys: sceneChars,
      purpose: si === 0 ? "introduce conflict" : "escalate",
      opening: sceneSents[0] ?? "",
      progression: sceneSents[1] ?? "",
      climax: sceneSents.at(-2) ?? "",
      ending: sceneSents.at(-1) ?? "",
      continuityNotes: /rain/i.test(chapterText) ? ["clothes are wet from rain"] : [],
      initialState: {},
      finalState: sceneChars[0] ? { [sceneChars[0]]: "shaken but determined" } : {},
      continuityDeltas: [],
      beats: sceneSents.slice(0, 4),
      pages,
    };
  });

  return {
    chapterSummary: sents.slice(0, 2).join(" ").slice(0, 300),
    openingState: sents[0] ?? "",
    closingState: sents.at(-1) ?? "",
    characterStateChanges: [],
    locationStateChanges: [],
    revealedFacts: [],
    scenes,
  };
}

export function mockPanelPrompts(
  panels: { id?: string; panelId?: string; beat?: string; storyBeat?: string }[],
): PanelPromptDraft {
  return {
    panels: panels.map((p) => ({
      panelId: String(p.panelId ?? p.id ?? ""),
      intent: `Show: ${p.beat ?? p.storyBeat ?? "the moment"}`,
      action: "Characters react naturally to the moment.",
      expression: "Restrained, readable emotion.",
      composition: "Clear focal subject, rule of thirds, uncluttered upper area.",
      lighting: "Directional key light with soft fill.",
      continuity: [],
    })),
  };
}

export function mockNarration(chapterText: string, panels: { id?: string; panelId?: string }[]): NarrationDraft {
  const sents = sentences(stripHeadings(chapterText)).filter((s) => !/["“]/.test(s));
  const lines = sents.slice(0, Math.max(3, Math.min(12, panels.length || 6))).map((text, i) => ({
    text,
    panelId: panels[i] ? String(panels[i]!.panelId ?? panels[i]!.id) : undefined,
  }));
  return { lines: lines.length ? lines : [{ text: "The story begins." }] };
}

/** One line per panel of roughly `wordsPerPanel` words, cycling through the chapter's sentences. */
export function mockNarrationV2(chapterText: string, panels: { id?: string }[], wordsPerPanel: number) {
  const words = stripHeadings(chapterText).replace(/["“”]/g, "").split(/\s+/).filter(Boolean);
  const pool = words.length ? words : "The story moves forward as the hero faces the next challenge".split(" ");
  let k = 0;
  const take = (n: number) => Array.from({ length: n }, () => pool[k++ % pool.length]).join(" ");
  const fail = /\[\[mock:short-narration\]\]/.test(chapterText);
  return {
    lines: panels.map((p) => ({
      text: `${take(fail ? 2 : wordsPerPanel).replace(/[.!?]+$/, "")}.`,
      panelId: String(p.id),
    })),
  };
}

export function mockRewrite(story: string, instruction: string) {
  return {
    content: `${story.trim()}\n\n(Revised per instruction: ${instruction.slice(0, 200)})`,
    notes: "mock rewrite",
  };
}

/** Produce the JSON object a text model would, based on the template header and tagged data. */
export function mockTextCompletion(messages: { role: string; content: string }[]): unknown {
  const system = messages.find((m) => m.role === "system")?.content ?? "";
  const user = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
  const tpl = extractTemplateName(system) ?? "";
  const story = extractTagged(user, "story_content")[0] ?? "";
  const data = extractTagged(user, "project_data").map((d) => {
    try {
      return JSON.parse(d) as unknown;
    } catch {
      return null;
    }
  });
  // Route by template name so version bumps don't need mock changes (versions with a different contract below).
  const name = tpl.replace(/-v\d+$/, "");
  const byName: Record<string, string> = {
    "story-analysis": "story-analysis-v1",
    "page-planning": "page-planning-v1",
    "shot-planning": "page-planning-v1",
    "strip-planning": "page-planning-v1",
    // Split planning: the outline drops the pages, the page pass returns one scene's worth.
    "chapter-outline": "chapter-outline-v1",
    "shot-outline": "chapter-outline-v1",
    "strip-outline": "chapter-outline-v1",
    "scene-pages": "scene-pages-v1",
    "scene-shots": "scene-pages-v1",
    "scene-strip": "scene-pages-v1",
    "panel-prompts": "panel-prompts-v1",
    "story-rewrite": "story-rewrite-v1",
    "json-repair": "json-repair-v1",
    "panel-check": "panel-check-v1",
  };
  const route = tpl === "narration-v1" ? tpl : name === "narration" ? "narration-v2" : (byName[name] ?? tpl);
  switch (route) {
    case "story-analysis-v1":
      return mockStoryAnalysis(story);
    case "page-planning-v1":
    case "page-planning-v2":
    case "page-planning-v3":
    case "page-planning-v4":
    case "shot-planning-v1": {
      const keys = [...user.matchAll(/"key":"([a-z0-9-]+)"/g)].map((m) => m[1]!);
      return mockChapterPlan((data[0] ?? {}) as ProjectData, story, keys);
    }
    case "chapter-outline-v1": {
      const keys = [...user.matchAll(/"key":"([a-z0-9-]+)"/g)].map((m) => m[1]!);
      const plan = mockChapterPlan((data[0] ?? {}) as ProjectData, story, keys);
      return { ...plan, scenes: plan.scenes.map(({ pages: _pages, ...scene }) => scene) };
    }
    case "scene-pages-v1": {
      const keys = [...user.matchAll(/"key":"([a-z0-9-]+)"/g)].map((m) => m[1]!);
      const plan = mockChapterPlan((data[0] ?? {}) as ProjectData, story, keys);
      // "Plan the pages of scene 2 of 5: ..." — the same generator ran for the outline, so the index lines up.
      const n = Number(user.match(/pages of scene (\d+) of /)?.[1] ?? 1);
      const scene = plan.scenes[Math.min(n, plan.scenes.length) - 1] ?? plan.scenes[0]!;
      return { pages: scene.pages };
    }
    case "panel-prompts-v1":
    case "panel-prompts-v2":
      return mockPanelPrompts((data[1] ?? []) as { id?: string }[]);
    case "narration-v2":
    case "narration-v3": {
      const d = (data[0] ?? {}) as { panels?: { id?: string }[] };
      const target = Number(user.match(/about (\d+) words per panel/)?.[1] ?? 21);
      return mockNarrationV2(story, d.panels ?? [], target);
    }
    case "narration-v1": {
      const d = (data[0] ?? {}) as { panels?: { id?: string }[] };
      return mockNarration(story, d.panels ?? []);
    }
    case "panel-check-v1": {
      const d = (data[0] ?? {}) as { expected?: { name: string }[] };
      const names = (d.expected ?? []).map((e) => e.name);
      // [[mock:qa-missing]] in the beat drops the last expected character.
      const missing = /\[\[mock:qa-missing\]\]/.test(user) ? names.slice(-1) : [];
      return {
        peopleCount: names.length - missing.length,
        expectedCharactersPresent: names.filter((n) => !missing.includes(n)),
        missingCharacters: missing,
        unexpectedPeople: 0,
        // [[mock:qa-text]] in the beat reports text drawn in the art.
        readableText: /\[\[mock:qa-text\]\]/.test(user),
        notes: "mock check",
      };
    }
    case "story-rewrite-v1":
      return mockRewrite(story, extractTagged(user, "editor_instruction")[0] ?? "");
    case "json-repair-v1": {
      const raw = data[0] as unknown;
      return raw ?? {};
    }
    default:
      return { text: "ok" };
  }
}
