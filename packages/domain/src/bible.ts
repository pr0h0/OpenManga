/**
 * The story bible in effect at a point of the story, cut down to what one prompt needs. Pure: callers resolve
 * chapters to their current order (1-based) and characters to names before calling.
 */

export type BibleFactEntry = {
  id: string;
  kind: string;
  subject: string;
  text: string;
  fixed: boolean;
  visual: boolean;
  /** Chapter order the fact holds from / until (inclusive); null = open. */
  from: number | null;
  until: number | null;
};

export type CharacterStateEntry = {
  id: string;
  character: string;
  kind: string;
  text: string;
  /** Chapter order it holds from; null = the start of the story. */
  chapter: number | null;
  /** Scene number within that chapter; null = the start of the chapter. */
  scene: number | null;
  until: number | null;
  /** Tie-break for entries at the same place: creation order. */
  seq: number;
};

/** What a prompt receives: short lines, fixed rules apart from the other facts, states grouped by character. */
export type BibleContext = {
  fixedRules: string[];
  facts: string[];
  characterStates: Record<string, string[]>;
};

/** A later entry of these kinds replaces the earlier one; the others accumulate until their end chapter. */
export const SINGLE_VALUED_STATE_KINDS = ["look", "outfit", "location", "rank"];
/** State kinds that can be seen in a picture, and so reach image prompts. Outfits reach them as the worn outfit. */
export const VISIBLE_STATE_KINDS = ["injury", "look", "item"];
/** Subjects that mean "the whole story". */
const GLOBAL_SUBJECTS = new Set(["", "world", "story", "all", "*", "everyone", "setting"]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `name` appears in `text` as whole words, ignoring case. */
export function mentions(text: string, name: string) {
  const n = name.trim();
  if (n.length < 2) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(n)}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

export const factInEffect = (f: Pick<BibleFactEntry, "from" | "until">, chapter: number) =>
  (f.from === null || f.from <= chapter) && (f.until === null || f.until >= chapter);

/**
 * The states that hold at `at`. With a scene, exactly the states in force there; without one (a whole chapter), the
 * states in force when the chapter opens plus every change during it, each marked with the scene it starts at.
 */
export function statesInEffect<T extends CharacterStateEntry>(
  states: T[],
  at: { chapter: number; scene?: number | null },
) {
  const scene = at.scene ?? null;
  const pos = (s: CharacterStateEntry) => [s.chapter ?? 0, s.scene ?? 0, s.seq] as const;
  const sorted = [...states].sort((a, b) => {
    const [x, y] = [pos(a), pos(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  const started = sorted.filter(
    (s) =>
      (s.until === null || s.until >= at.chapter) &&
      (s.chapter === null ||
        s.chapter < at.chapter ||
        (s.chapter === at.chapter && (scene === null || s.scene === null || s.scene <= scene))),
  );
  // A change part-way through this chapter, seen from the chapter as a whole.
  const midChapter = (s: CharacterStateEntry) => scene === null && s.chapter === at.chapter && s.scene !== null;
  const out: T[] = [];
  for (const s of started) {
    if (SINGLE_VALUED_STATE_KINDS.includes(s.kind) && !midChapter(s)) {
      // Only the latest of its kind holds; a mid-chapter change does not replace what the chapter opened with.
      const i = out.findIndex((o) => o.character === s.character && o.kind === s.kind && !midChapter(o));
      if (i >= 0) out.splice(i, 1);
    }
    out.push(s);
  }
  return out;
}

/**
 * The bible for one prompt: facts in effect at the chapter, about a subject the prompt is about (named in `names`, or
 * mentioned in `text`) or about the whole story; and the states in effect of the characters in `characters`.
 * Fixed rules come first and are kept before other facts when the list is cut to `maxFacts`.
 */
export function bibleInEffect(
  bible: { facts: BibleFactEntry[]; states: CharacterStateEntry[] },
  at: { chapter: number; scene?: number | null },
  opts: {
    /** Names (with aliases) of who and what the prompt is about. */
    names: string[];
    /** Text the prompt is about (the chapter's source, a panel's beat): a subject mentioned in it is relevant too. */
    text?: string;
    /** Whose states to include; defaults to `names`. */
    characters?: string[];
    /** Image prompts: only what can be seen. */
    visualOnly?: boolean;
    maxFacts?: number;
    maxStates?: number;
  },
): BibleContext {
  const maxFacts = opts.maxFacts ?? 40;
  const maxStates = opts.maxStates ?? 40;
  const names = opts.names.filter((n) => n.trim().length >= 2);
  const relevant = (subject: string) => {
    const s = subject.trim();
    if (GLOBAL_SUBJECTS.has(s.toLowerCase())) return true;
    return names.some((n) => mentions(s, n)) || (opts.text ? mentions(opts.text, s) : false);
  };
  const facts = bible.facts
    .filter((f) => factInEffect(f, at.chapter) && (!opts.visualOnly || f.visual) && relevant(f.subject))
    .sort((a, b) => Number(b.fixed) - Number(a.fixed));
  const kept = facts.slice(0, maxFacts);
  const line = (f: BibleFactEntry) => {
    const subject = f.subject.trim();
    return `${subject && !GLOBAL_SUBJECTS.has(subject.toLowerCase()) ? `${subject} (${f.kind}): ` : `(${f.kind}) `}${f.text.trim()}`;
  };
  const who = new Set((opts.characters ?? names).map((n) => n.trim().toLowerCase()));
  const characterStates: Record<string, string[]> = {};
  let n = 0;
  for (const s of statesInEffect(
    bible.states.filter((s) => who.has(s.character.trim().toLowerCase())),
    at,
  )) {
    if (opts.visualOnly && !VISIBLE_STATE_KINDS.includes(s.kind)) continue;
    if (n++ >= maxStates) break;
    const from = at.scene == null && s.chapter === at.chapter && s.scene !== null ? ` (from scene ${s.scene})` : "";
    characterStates[s.character] = [...(characterStates[s.character] ?? []), `${s.kind}: ${s.text.trim()}${from}`];
  }
  return {
    fixedRules: kept.filter((f) => f.fixed).map(line),
    facts: kept.filter((f) => !f.fixed).map(line),
    characterStates,
  };
}

/** The context as plain lines, for prompts that take a list (image prompts). */
export const bibleLines = (b: BibleContext) => [
  ...b.fixedRules,
  ...b.facts,
  ...Object.entries(b.characterStates).flatMap(([name, lines]) => lines.map((l) => `${name} — ${l}`)),
];

/** True when the context carries nothing, so a prompt can leave the bible out entirely. */
export const bibleIsEmpty = (b: BibleContext) =>
  !b.fixedRules.length && !b.facts.length && !Object.keys(b.characterStates).length;
