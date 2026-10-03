import { describe, expect, test } from "bun:test";
import { type BibleFactEntry, bibleInEffect, type CharacterStateEntry, mentions, statesInEffect } from "./bible.ts";

const fact = (p: Partial<BibleFactEntry>): BibleFactEntry => ({
  id: crypto.randomUUID(),
  kind: "character",
  subject: "",
  text: "x",
  fixed: false,
  visual: false,
  from: null,
  until: null,
  ...p,
});
let seq = 0;
const state = (p: Partial<CharacterStateEntry>): CharacterStateEntry => ({
  id: crypto.randomUUID(),
  character: "Jin",
  kind: "injury",
  text: "x",
  chapter: null,
  scene: null,
  until: null,
  seq: seq++,
  ...p,
});

describe("story bible in effect", () => {
  test("mentions matches whole words only, ignoring case", () => {
    expect(mentions("Jin and Hana", "hana")).toBe(true);
    expect(mentions("Hanako waits", "Hana")).toBe(false);
    expect(mentions("Woo-jin smiles", "Woo-jin")).toBe(true);
  });

  test("facts hold only inside their chapter range; fixed rules first", () => {
    const bible = {
      facts: [
        fact({ subject: "Jin", text: "has the belt", from: 7 }),
        fact({ subject: "Jin", text: "does not know Hana is the heir", until: 11, fixed: true }),
        fact({ subject: "world", kind: "rule", text: "no guns exist", fixed: true }),
        fact({ subject: "Mara", text: "is a spy" }),
      ],
      states: [],
    };
    const at3 = bibleInEffect(bible, { chapter: 3 }, { names: ["Jin"] });
    expect(at3.fixedRules).toEqual(["Jin (character): does not know Hana is the heir", "(rule) no guns exist"]);
    expect(at3.facts).toEqual([]);
    const at12 = bibleInEffect(bible, { chapter: 12 }, { names: ["Jin"] });
    expect(at12.fixedRules).toEqual(["(rule) no guns exist"]);
    expect(at12.facts).toEqual(["Jin (character): has the belt"]);
  });

  test("a subject named in the prompt's text is relevant; others are left out", () => {
    const bible = { facts: [fact({ subject: "the Guild", kind: "organisation", text: "wears grey" })], states: [] };
    expect(bibleInEffect(bible, { chapter: 1 }, { names: [], text: "They reach the Guild hall." }).facts).toHaveLength(
      1,
    );
    expect(bibleInEffect(bible, { chapter: 1 }, { names: ["Jin"], text: "Jin sleeps." }).facts).toHaveLength(0);
  });

  test("visual only keeps visual facts and visible states", () => {
    const bible = {
      facts: [
        fact({ subject: "Jin", text: "scar on the LEFT jaw", fixed: true, visual: true }),
        fact({ subject: "Jin", text: "cannot read", fixed: true }),
      ],
      states: [state({ kind: "injury", text: "arm in a sling" }), state({ kind: "knowledge", text: "knows the code" })],
    };
    const v = bibleInEffect(bible, { chapter: 2 }, { names: ["Jin"], visualOnly: true });
    expect(v.fixedRules).toEqual(["Jin (character): scar on the LEFT jaw"]);
    expect(v.characterStates).toEqual({ Jin: ["injury: arm in a sling"] });
  });

  test("single-valued states are replaced; others hold until their end", () => {
    const states = [
      state({ kind: "outfit", text: "school uniform", chapter: 1 }),
      state({ kind: "outfit", text: "armour", chapter: 4 }),
      state({ kind: "injury", text: "cut cheek", chapter: 2, until: 3 }),
      state({ kind: "item", text: "the key", chapter: 2 }),
    ];
    const texts = (s: CharacterStateEntry[]) => s.map((x) => x.text);
    expect(texts(statesInEffect(states, { chapter: 3 }))).toEqual(["school uniform", "cut cheek", "the key"]);
    expect(texts(statesInEffect(states, { chapter: 5 }))).toEqual(["the key", "armour"]);
  });

  test("a scene point sees changes up to it; a whole chapter sees them marked with their scene", () => {
    const states = [
      state({ kind: "outfit", text: "suit", chapter: 1 }),
      state({ kind: "outfit", text: "torn suit", chapter: 5, scene: 3 }),
    ];
    const texts = (s: CharacterStateEntry[]) => s.map((x) => x.text);
    expect(texts(statesInEffect(states, { chapter: 5, scene: 2 }))).toEqual(["suit"]);
    expect(texts(statesInEffect(states, { chapter: 5, scene: 3 }))).toEqual(["torn suit"]);
    expect(bibleInEffect({ facts: [], states }, { chapter: 5 }, { names: ["Jin"] }).characterStates).toEqual({
      Jin: ["outfit: suit", "outfit: torn suit (from scene 3)"],
    });
  });

  test("states of characters outside the prompt are left out, and lists are capped", () => {
    const states = [state({ character: "Hana", text: "bruised" }), state({ text: "a" }), state({ text: "b" })];
    const facts = Array.from({ length: 5 }, (_, i) => fact({ text: `f${i}` }));
    const b = bibleInEffect({ facts, states }, { chapter: 1 }, { names: ["Jin"], maxFacts: 2, maxStates: 1 });
    expect(b.characterStates).toEqual({ Jin: ["injury: a"] });
    expect(b.facts).toHaveLength(2);
  });
});
