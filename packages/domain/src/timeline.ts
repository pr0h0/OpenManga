/**
 * Story timeline arithmetic: elapsed time between events, characters' ages, and where a bible state (held from a
 * chapter and scene) sits in story time. Events come in story-time order; `day` is a story-day number.
 */

export type TimelinePoint = {
  id: string;
  kind: "event" | "birth";
  day: number | null;
  characterIds: string[];
  /** The telling order of the chapter it is tied to, and the scene number in it. */
  chapter: number | null;
  scene: number | null;
};

/** "3 days", "2 weeks", "5 months", "12 years"; under a day in hours. */
export function elapsedLabel(days: number): string {
  const d = Math.abs(days);
  const unit = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (d === 0) return "the same day";
  if (d < 1) return unit(Math.max(1, Math.round(d * 24)), "hour");
  if (d < 14) return unit(Math.round(d), "day");
  if (d < 60) return unit(Math.round(d / 7), "week");
  if (d < 730) return unit(Math.round(d / 30.44), "month");
  return unit(Math.round(d / 365.25), "year");
}

export const ageAt = (birthDay: number, day: number) => Math.floor((day - birthDay) / 365.25);

/**
 * Per event: time since the previous dated event, whether its day runs backwards (earlier than an event listed before
 * it, which the story-time order says cannot be), and the age of each of its characters with a dated birth.
 */
export function timelineView(events: TimelinePoint[]) {
  const births = new Map<string, number>();
  for (const e of events)
    if (e.kind === "birth" && e.day !== null) for (const c of e.characterIds) if (!births.has(c)) births.set(c, e.day);
  let prev: number | null = null;
  let latest = Number.NEGATIVE_INFINITY;
  return events.map((e) => {
    const since = e.day !== null && prev !== null ? e.day - prev : null;
    const outOfOrder = e.day !== null && e.day < latest;
    if (e.day !== null) {
      prev = e.day;
      latest = Math.max(latest, e.day);
    }
    const ages: Record<string, number> = {};
    if (e.day !== null && e.kind !== "birth")
      for (const c of e.characterIds) {
        const b = births.get(c);
        if (b !== undefined && e.day >= b) ages[c] = ageAt(b, e.day);
      }
    return { id: e.id, since, elapsed: since === null ? null : elapsedLabel(since), outOfOrder, ages };
  });
}

/**
 * The event a state held from chapter `chapter` (telling order) and scene `scene` starts at: the last event of that
 * chapter told at or before the scene, else the chapter's first event, else the last event of the nearest earlier
 * chapter that has one. Null when the state holds from the start of the story or nothing earlier is on the timeline.
 */
export function placeOnTimeline(
  events: TimelinePoint[],
  at: { chapter: number | null; scene: number | null },
): string | null {
  if (at.chapter === null) return null;
  const own = events.filter((e) => e.chapter === at.chapter);
  if (own.length) {
    const upTo = own.filter((e) => (e.scene ?? 0) <= (at.scene ?? 0));
    const pick = upTo.length ? upTo.reduce((a, b) => ((b.scene ?? 0) >= (a.scene ?? 0) ? b : a)) : own[0]!;
    return pick.id;
  }
  const earlier = events.filter((e) => e.chapter !== null && e.chapter < at.chapter!);
  if (!earlier.length) return null;
  const top = Math.max(...earlier.map((e) => e.chapter!));
  return earlier.filter((e) => e.chapter === top).at(-1)!.id;
}
