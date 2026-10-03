import {
  and,
  asc,
  bibleFacts,
  chapters,
  characterAliases,
  characterStates,
  characters,
  type DbOrTx,
  eq,
  inArray,
  isNull,
} from "@openmanga/db";
import {
  type BibleContext,
  type BibleFactEntry,
  bibleInEffect,
  type CharacterStateEntry,
  mentions,
} from "@openmanga/domain";

/** The whole bible of a project with chapters resolved to their current order and characters to names. */
export async function loadBible(db: DbOrTx, projectId: string) {
  const chs = await db
    .select({ id: chapters.id, order: chapters.order })
    .from(chapters)
    .where(eq(chapters.projectId, projectId));
  const orderOf = (id: string | null) => (id ? (chs.find((c) => c.id === id)?.order ?? null) : null);
  const factRows = await db
    .select()
    .from(bibleFacts)
    .where(eq(bibleFacts.projectId, projectId))
    .orderBy(asc(bibleFacts.createdAt));
  const stateRows = await db
    .select({ s: characterStates, name: characters.name })
    .from(characterStates)
    .innerJoin(characters, eq(characters.id, characterStates.characterId))
    .where(and(eq(characterStates.projectId, projectId), isNull(characters.deletedAt)))
    .orderBy(asc(characterStates.createdAt));
  const cast = await db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)));
  const aliases = cast.length
    ? await db
        .select({ characterId: characterAliases.characterId, alias: characterAliases.alias })
        .from(characterAliases)
        .where(
          inArray(
            characterAliases.characterId,
            cast.map((c) => c.id),
          ),
        )
    : [];
  const facts: BibleFactEntry[] = factRows.map((f) => ({
    id: f.id,
    kind: f.kind,
    subject: f.subject,
    text: f.text,
    fixed: f.fixed,
    visual: f.visual,
    from: orderOf(f.fromChapterId),
    until: orderOf(f.untilChapterId),
  }));
  const states: CharacterStateEntry[] = stateRows.map(({ s, name }, seq) => ({
    id: s.id,
    character: name,
    kind: s.kind,
    text: s.text,
    chapter: orderOf(s.chapterId),
    scene: s.sceneNumber,
    until: orderOf(s.untilChapterId),
    seq,
  }));
  return {
    facts,
    states,
    cast: cast.map((c) => ({
      ...c,
      aliases: aliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
    })),
    chapterOrder: orderOf,
  };
}

export type LoadedBible = Awaited<ReturnType<typeof loadBible>>;

/**
 * The bible one prompt receives at a chapter (and scene): the cast it is about are those named in `names`, or whose
 * name or alias the `text` mentions; other subjects (places, objects, terms) are relevant when `names` or `text`
 * mention them.
 */
export function bibleFor(
  bible: LoadedBible,
  at: { chapter: number; scene?: number | null },
  opts: { names?: string[]; text?: string; visualOnly?: boolean; maxFacts?: number; maxStates?: number },
): BibleContext {
  const named = new Set((opts.names ?? []).map((n) => n.toLowerCase()));
  const present = bible.cast.filter(
    (c) =>
      [c.name, ...c.aliases].some((n) => named.has(n.toLowerCase())) ||
      (opts.text ? [c.name, ...c.aliases].some((n) => mentions(opts.text!, n)) : false),
  );
  return bibleInEffect(bible, at, {
    names: [...(opts.names ?? []), ...present.flatMap((c) => [c.name, ...c.aliases])],
    text: opts.text,
    characters: present.map((c) => c.name),
    visualOnly: opts.visualOnly,
    maxFacts: opts.maxFacts,
    maxStates: opts.maxStates,
  });
}
