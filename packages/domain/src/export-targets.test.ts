import { expect, test } from "bun:test";
import { checkExportTarget, EXPORT_TARGETS, exportTarget } from "./export-targets.ts";

test("every target is complete and has a unique key", () => {
  expect(new Set(EXPORT_TARGETS.map((t) => t.key)).size).toBe(EXPORT_TARGETS.length);
  for (const t of EXPORT_TARGETS) expect(t.notes.length).toBeGreaterThan(0);
});

test("a Short over three minutes is blocked, naming the limit", () => {
  const t = exportTarget("youtube_shorts")!;
  expect(checkExportTarget(t, { durationMs: 170_000 })).toEqual([]);
  const [i] = checkExportTarget(t, { durationMs: 200_000 });
  expect(i).toMatchObject({ level: "block", code: "too_long" });
  expect(i!.message).toBe("3:20 long; YouTube Shorts takes at most 3:00.");
});

test("WEBTOON Canvas: image height, size and the episode total; a wrong width is only a note", () => {
  const t = exportTarget("webtoon_canvas")!;
  const img = (name: string, height: number, bytes: number, width = 800) => ({ name, width, height, bytes });
  const issues = checkExportTarget(t, {
    images: [
      img("a", 1280, 1_000_000),
      img("b", 1300, 3_000_000),
      ...Array.from({ length: 9 }, (_, i) => img(`c${i}`, 1280, 2_000_000, 700)),
    ],
  });
  expect(issues.map((i) => [i.code, i.level])).toEqual([
    ["image_width", "info"],
    ["image_too_tall", "block"],
    ["image_too_big", "block"],
    ["total_too_big", "block"],
  ]);
  expect(issues[0]!.message).toContain("and 6 more");
});

test("KDP page counts", () => {
  const t = exportTarget("kdp_paperback")!;
  expect(checkExportTarget(t, { pages: 12 })[0]!.code).toBe("too_few_pages");
  expect(checkExportTarget(t, { pages: 120 })).toEqual([]);
  expect(checkExportTarget(t, { pages: 900 })[0]!.code).toBe("too_many_pages");
});
