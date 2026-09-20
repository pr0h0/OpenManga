/**
 * Content-policy linting for text that reaches image prompts. Image moderators (Meta Muse especially) are
 * probabilistic: a character described as underweight + scarred, or a lone figure underlit in deep shadow,
 * trips them some of the time on otherwise harmless scenes. Everything here only warns and suggests; nothing
 * blocks. Browser-safe (used by the web editor, the API, the preflight check and provider sanitisation).
 */

/** `soften: false` for words with common harmless meanings ("wound up", "slow burn"): warn only, never rewrite. */
export type HarmTerm = { pattern: RegExp; term: string; suggestion: string; soften: boolean };

const t = (term: string, suggestion: string, pattern?: string, soften = true): HarmTerm => ({
  term,
  suggestion,
  soften,
  pattern: new RegExp(`\\b${pattern ?? term.replace(/ /g, "\\s+")}\\b`, "gi"),
});

/** Body-harm vocabulary: read together these look like malnutrition or injury to a moderator. */
export const HARM_TERMS: HarmTerm[] = [
  t("slightly underweight", "slim"),
  t("underweight", "slim"),
  t("gaunt", "lean"),
  t("emaciated", "slender"),
  t("skeletal", "slender"),
  t("hollow cheeks", "defined cheekbones", "hollow(?:ed)?[\\s-]+cheek(?:s|ed)?"),
  t("sunken", "deep-set", "sunken", false),
  t("sallow", "pale", "sallow"),
  t("malnourished", "slim"),
  t("starving", "hungry", "starv(?:ing|ed)", false),
  t("burn scar", "small faded mark", "burn[\\s-]+scars?"),
  t("scar", "small faded mark", "scar(?:s|red|ring)?"),
  t("burn", "faded mark", "burn(?:s|ed|t)?", false),
  t("bruise", "smudge", "bruis(?:e|es|ed|ing)"),
  t("wound", "bandage", "wound(?:s|ed)?", false),
  t("blood", "red paint", "blood(?:y|ied|stained)?", false),
];

export type LintMatch = { term: string; match: string; suggestion: string };

/** Harm vocabulary found in a piece of text (overlapping terms reported once, longest first). */
export function lintText(text: string | null | undefined): LintMatch[] {
  if (!text) return [];
  const out: LintMatch[] = [];
  const taken: [number, number][] = [];
  for (const h of HARM_TERMS) {
    for (const m of text.matchAll(h.pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      taken.push([start, end]);
      out.push({ term: h.term, match: m[0], suggestion: h.suggestion });
    }
  }
  return out;
}

/** Replaces harm vocabulary with its neutral suggestion (used as a per-provider prompt policy). */
export function softenText(text: string): { text: string; replaced: string[] } {
  const replaced: string[] = [];
  let out = text;
  for (const h of HARM_TERMS) {
    if (!h.soften) continue;
    out = out.replace(h.pattern, (m) => {
      replaced.push(m);
      return h.suggestion;
    });
  }
  return { text: out, replaced };
}

type BibleLike = {
  genderPresentation?: string;
  ageRange?: string;
  height?: string;
  build?: string;
  faceShape?: string;
  skinTone?: string;
  eyes?: string;
  eyebrows?: string;
  nose?: string;
  mouth?: string;
  hair?: string;
  facialHair?: string;
  distinctiveFeatures?: string[];
  wardrobe?: string;
  outfitVariants?: { name: string; description?: string }[];
};

/** Character fields that are compiled into image prompts. `personality`, `summary` etc. never reach the model. */
export function promptVisibleCharacter(bible: BibleLike, immutableTraits: string[] = []) {
  return {
    genderPresentation: bible.genderPresentation ?? "",
    ageRange: bible.ageRange ?? "",
    height: bible.height ?? "",
    build: bible.build ?? "",
    faceShape: bible.faceShape ?? "",
    skinTone: bible.skinTone ?? "",
    eyes: bible.eyes ?? "",
    eyebrows: bible.eyebrows ?? "",
    nose: bible.nose ?? "",
    mouth: bible.mouth ?? "",
    hair: bible.hair ?? "",
    facialHair: bible.facialHair ?? "",
    distinctiveFeatures: bible.distinctiveFeatures ?? [],
    wardrobe: bible.wardrobe ?? "",
    outfitVariants: (bible.outfitVariants ?? []).map((o) => `${o.name}: ${o.description ?? ""}`),
    immutableTraits,
  };
}

export type FieldLint = LintMatch & { field: string; excerpt: string };

/** Lints every prompt-visible field of a character bible (plus extra outfit texts). */
export function lintCharacter(
  bible: BibleLike,
  immutableTraits: string[] = [],
  outfits: { name: string; description: string }[] = [],
): FieldLint[] {
  const fields = promptVisibleCharacter(bible, immutableTraits);
  const entries: [string, string][] = [];
  for (const [field, v] of Object.entries(fields)) {
    if (Array.isArray(v)) for (const s of v) entries.push([field, s]);
    else entries.push([field, v]);
  }
  for (const o of outfits) entries.push([`outfit "${o.name}"`, o.description]);
  return entries.flatMap(([field, text]) =>
    lintText(text).map((m) => ({ ...m, field, excerpt: text.length > 120 ? `${text.slice(0, 117)}…` : text })),
  );
}

const UNDERLIGHT =
  /\b(bare\s+bulb|single\s+bare|pooled\s+light|deep\s+shadows?|harsh\s+shadows?|bulb\s+dim|dim\s+bulb|hard\s+bulb|lit\s+from\s+below|underlit|under-lit|glow\s+from\s+below|from\s+below|flicker(?:ing)?|horror|ominous|pitch[\s-]+dark|darkness)\b/i;
const DISTRESS =
  /\b(exhaust(?:ed|ion)|vertigo|denial|despair|dread|panic(?:ked)?|hopeless|numb|terrified|anguish|breakdown|distress(?:ed)?|trauma|grief|sobbing|shaking|haunted|broken|defeated|desperate)\b/i;
const STRESS_ANGLES = new Set(["high", "dutch", "birds-eye", "worms-eye"]);

export type PanelRiskInput = {
  lighting?: string | null;
  emotion?: string | null;
  cameraAngle?: string | null;
  characterCount: number;
};

/**
 * The visual grammar of distress: a lone figure, underlit or in deep shadow, with a distressed mood, often shot
 * from above or tilted. Moderators block it even when the scene is mundane. Returns the reasons that apply when
 * at least lighting + mood (or lighting + angle) combine on a single-character panel.
 */
export function panelDistressRisk(i: PanelRiskInput): string[] {
  if (i.characterCount !== 1) return [];
  const reasons: string[] = [];
  const light = i.lighting?.match(UNDERLIGHT)?.[0];
  const mood = i.emotion?.match(DISTRESS)?.[0];
  const angle = i.cameraAngle && STRESS_ANGLES.has(i.cameraAngle) ? i.cameraAngle : null;
  if (light) reasons.push(`lighting "${light}"`);
  if (mood) reasons.push(`mood "${mood}"`);
  if (angle) reasons.push(`${angle} camera`);
  return light && (mood || angle) ? ["lone figure", ...reasons] : [];
}

/**
 * Categories a provider named when it refused on content policy, e.g. OpenAI's
 * `safety_violations=[self-harm]`. A named category is a verdict about the prompt's content and repeats on every
 * identical retry; an unnamed refusal ("the prompt triggered our content management policy") is the
 * probabilistic filter, which a plain retry often clears. Callers use the distinction to decide whether
 * retrying is worth anything.
 */
export function policyCategories(providerMessage: string | null | undefined): string[] {
  const listed = /safety_violations\s*=\s*\[([^\]]*)\]/i.exec(providerMessage ?? "");
  if (!listed) return [];
  return listed[1]!
    .split(",")
    .map((c) => c.trim().replace(/^['"]|['"]$/g, ""))
    .filter(Boolean);
}
