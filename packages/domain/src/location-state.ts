/**
 * Which state of a place a scene shows. A scene's own pick wins. Otherwise a state whose keywords match the scene's
 * time or weather ("night", "snow"), then a state whose chapter range holds the scene ("destroyed" from chapter 7
 * on); among several, the one starting latest. A state with neither keywords nor a range is only ever picked by hand.
 */
export type LocationStateRule = {
  id: string;
  keywords: string[];
  /** Chapter range by telling order, inclusive; null = open. */
  from: number | null;
  until: number | null;
};

const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

export function pickLocationState(
  states: LocationStateRule[],
  at: { chapter: number | null; time: string; weather: string; explicit: string | null },
): string | null {
  if (at.explicit && states.some((s) => s.id === at.explicit)) return at.explicit;
  const inRange = (s: LocationStateRule) =>
    at.chapter === null
      ? s.from === null && s.until === null
      : (s.from === null || at.chapter >= s.from) && (s.until === null || at.chapter <= s.until);
  const scene = words(`${at.time} ${at.weather}`);
  const matches = (s: LocationStateRule) =>
    s.keywords.some((k) => {
      const kw = [...words(k)];
      return kw.length > 0 && kw.every((w) => scene.has(w));
    });
  const latest = (xs: LocationStateRule[]) =>
    xs.reduce<LocationStateRule | null>((a, b) => (!a || (b.from ?? 0) > (a.from ?? 0) ? b : a), null)?.id ?? null;
  const byWords = states.filter((s) => s.keywords.length && inRange(s) && matches(s));
  if (byWords.length) return latest(byWords);
  return latest(states.filter((s) => !s.keywords.length && (s.from !== null || s.until !== null) && inRange(s)));
}
