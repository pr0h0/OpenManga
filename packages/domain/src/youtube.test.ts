import { describe, expect, test } from "bun:test";
import {
  first48Curve,
  isoDurationSeconds,
  parseCsv,
  parseYouTubeVideoId,
  reachRowsFromCsv,
  snapshotDue,
  snapshotExpired,
} from "./youtube.ts";

const ID = "dQw4w9WgXcQ";

describe("parseYouTubeVideoId", () => {
  test.each([
    ID,
    ` ${ID} `,
    `https://www.youtube.com/watch?v=${ID}`,
    `https://youtube.com/watch?v=${ID}&t=42s&list=PL123&si=abc`,
    `https://www.youtube.com/watch?feature=share&v=${ID}`,
    `http://m.youtube.com/watch?v=${ID}`,
    `https://music.youtube.com/watch?v=${ID}&si=x`,
    `https://youtu.be/${ID}`,
    `https://youtu.be/${ID}?t=10&si=xyz`,
    `youtu.be/${ID}`,
    `www.youtube.com/watch?v=${ID}`,
    `https://www.youtube.com/shorts/${ID}`,
    `https://youtube.com/shorts/${ID}?feature=share`,
    `https://www.youtube.com/live/${ID}?si=abc`,
    `https://www.youtube.com/embed/${ID}?start=5`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
    `https://WWW.YOUTUBE.COM/watch?v=${ID}`,
  ])("%s", (input) => expect(parseYouTubeVideoId(input)).toBe(ID));

  test.each([
    "",
    "dQw4w9WgXc",
    "dQw4w9WgXcQQ",
    "dQw4w9WgXc!",
    "https://www.youtube.com/playlist?list=PL123",
    "https://www.youtube.com/@channel",
    "https://www.youtube.com/watch?v=short",
    `https://evil.example/watch?v=${ID}`,
    `https://youtube.com.evil.example/watch?v=${ID}`,
    `javascript:alert(1)//${ID}`,
    `https://youtu.be/`,
  ])("rejects %p", (input) => expect(parseYouTubeVideoId(input)).toBeNull());
});

describe("snapshot schedule", () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const ago = (h: number) => new Date(now.getTime() - h * 3600_000);
  test("hourly in the first 48 hours, connected or not", () => {
    for (const connected of [true, false]) {
      expect(snapshotDue({ publishedAt: ago(5), connected, lastSnapshotAt: null }, now)).toBe(true);
      expect(snapshotDue({ publishedAt: ago(5), connected, lastSnapshotAt: ago(0.5) }, now)).toBe(false);
      expect(snapshotDue({ publishedAt: ago(47), connected, lastSnapshotAt: ago(0.97) }, now)).toBe(true);
    }
  });
  test("then daily only for videos on channels that are not connected", () => {
    expect(snapshotDue({ publishedAt: ago(100), connected: true, lastSnapshotAt: ago(30) }, now)).toBe(false);
    expect(snapshotDue({ publishedAt: ago(100), connected: false, lastSnapshotAt: ago(30) }, now)).toBe(true);
    expect(snapshotDue({ publishedAt: ago(100), connected: false, lastSnapshotAt: ago(3) }, now)).toBe(false);
    expect(snapshotDue({ publishedAt: null, connected: false, lastSnapshotAt: null }, now)).toBe(true);
  });
  test("retention: unauthorized snapshots go after 30 days, authorized ones stay", () => {
    expect(snapshotExpired({ takenAt: ago(24 * 31), authorized: false }, now)).toBe(true);
    expect(snapshotExpired({ takenAt: ago(24 * 29), authorized: false }, now)).toBe(false);
    expect(snapshotExpired({ takenAt: ago(24 * 400), authorized: true }, now)).toBe(false);
  });
});

describe("first48Curve", () => {
  const pub = new Date("2026-10-01T00:00:00Z");
  const at = (h: number) => new Date(pub.getTime() + h * 3600_000);
  test("interpolates between snapshots and never extrapolates", () => {
    const c = first48Curve(pub, [
      { takenAt: at(2), views: 200 },
      { takenAt: at(4), views: 600 },
    ]);
    expect(c).toHaveLength(49);
    expect(c.slice(0, 6)).toEqual([0, 100, 200, 400, 600, null]);
    expect(c[48]).toBeNull();
  });
  test("ignores snapshots outside the window and unordered input", () => {
    const c = first48Curve(pub, [
      { takenAt: at(48), views: 4800 },
      { takenAt: at(-1), views: 5 },
      { takenAt: at(24), views: 2400 },
      { takenAt: at(80), views: 9999 },
    ]);
    expect(c[12]).toBe(1200);
    expect(c[36]).toBe(3600);
    expect(c[48]).toBe(4800);
  });
  test("no snapshots: only hour zero", () => {
    expect(first48Curve(pub, []).filter((v) => v !== null)).toEqual([0]);
  });
});

describe("reach reports", () => {
  test("csv with quotes and CRLF", () => {
    expect(parseCsv('a,b\r\n"x,1","say ""hi"""\r\n')).toEqual([
      ["a", "b"],
      ["x,1", 'say "hi"'],
    ]);
  });
  test("basic report kept as impressions and CTR per video and day", () => {
    const csv =
      "date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr\n20261001,UC1,vid00000001,1000,0.05\n20261002,UC1,vid00000001,500,0.04\n";
    expect(reachRowsFromCsv(csv, "basic")).toEqual([
      { videoId: "vid00000001", day: "2026-10-01", source: "", impressions: 1000, ctr: 0.05 },
      { videoId: "vid00000001", day: "2026-10-02", source: "", impressions: 500, ctr: 0.04 },
    ]);
  });
  test("combined report summed to impressions per traffic source, without CTR", () => {
    const csv = [
      "date,channel_id,video_id,traffic_source_type,traffic_source_detail,operating_system,device_type,video_thumbnail_impressions,video_thumbnail_impressions_ctr",
      "20261001,UC1,vid00000001,5,,1,1,100,0.1",
      "20261001,UC1,vid00000001,5,x,2,2,50,0.2",
      "20261001,UC1,vid00000001,3,,1,1,7,0",
    ].join("\n");
    expect(reachRowsFromCsv(csv, "combined")).toEqual([
      { videoId: "vid00000001", day: "2026-10-01", source: "5", impressions: 150, ctr: null },
      { videoId: "vid00000001", day: "2026-10-01", source: "3", impressions: 7, ctr: null },
    ]);
  });
  test("a report without the needed columns fails loudly", () => {
    expect(() => reachRowsFromCsv("date,foo\n20261001,1\n", "basic")).toThrow();
  });
});

test("isoDurationSeconds", () => {
  expect(isoDurationSeconds("PT1H2M3S")).toBe(3723);
  expect(isoDurationSeconds("PT45S")).toBe(45);
  expect(isoDurationSeconds("P1DT1S")).toBe(86401);
  expect(isoDurationSeconds("bad")).toBeNull();
});
