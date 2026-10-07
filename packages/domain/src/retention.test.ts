import { expect, test } from "bun:test";
import { GB, type RetentionCandidate, selectForRetention } from "./retention.ts";

const now = new Date("2026-10-07T00:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const c = (id: string, age: number, gb: number): RetentionCandidate => ({
  id,
  kind: "export",
  bytes: gb * GB,
  createdAt: daysAgo(age),
});
const policy = { enabled: true, mode: "auto" as const };

test("age: everything older than the limit goes, nothing newer", () => {
  const r = selectForRetention([c("new", 5, 1), c("old", 40, 1), c("older", 90, 2)], 10 * GB, {
    ...policy,
    maxAgeDays: 30,
    maxTotalGb: null,
  });
  expect(r.selected.map((x) => x.id)).toEqual(["older", "old"]);
  expect(r).toMatchObject({
    files: 2,
    bytes: 3 * GB,
    afterBytes: 7 * GB,
    overLimitBytes: 0,
    reasons: { age: 2, size: 0 },
  });
});

test("size: the oldest go until the total is under the limit, and no further", () => {
  const files = [c("a", 1, 2), c("b", 3, 2), c("c", 2, 2), c("d", 9, 2)];
  const r = selectForRetention(files, 105 * GB, { ...policy, maxAgeDays: null, maxTotalGb: 100 });
  // 105 → 103 (d, 9 days) → 101 (b, 3 days) → 99 (c, 2 days): under 100, the newest stays.
  expect(r.selected.map((x) => x.id)).toEqual(["d", "b", "c"]);
  expect(r.afterBytes).toBe(99 * GB);
  expect(r.reasons).toEqual({ age: 0, size: 3 });
});

test("both: whichever is crossed first; the age limit's deletions count towards the size limit", () => {
  const files = [c("fresh", 1, 3), c("week", 7, 3), c("stale", 45, 3)];
  const r = selectForRetention(files, 104 * GB, { ...policy, maxAgeDays: 30, maxTotalGb: 100 });
  // Age removes "stale" (104 → 101), still over 100: the oldest of the rest ("week") goes too.
  expect(r.selected.map((x) => x.id)).toEqual(["stale", "week"]);
  expect(r.reasons).toEqual({ age: 1, size: 1 });
  expect(selectForRetention(files, 50 * GB, { ...policy, maxAgeDays: 30, maxTotalGb: 100 }).files).toBe(1);
  expect(selectForRetention(files, 50 * GB, { ...policy, maxAgeDays: null, maxTotalGb: null }).files).toBe(0);
});

test("files in use cannot make room: what is still over the limit is reported", () => {
  const r = selectForRetention([c("only", 1, 1)], 150 * GB, { ...policy, maxAgeDays: null, maxTotalGb: 100 });
  expect(r.files).toBe(1);
  expect(r.overLimitBytes).toBe(49 * GB);
  expect(r.byKind).toEqual({ export: { files: 1, bytes: GB } });
});
