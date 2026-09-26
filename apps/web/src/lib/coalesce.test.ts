import { expect, test } from "bun:test";
import { coalesce } from "./coalesce.ts";

test("a burst of calls runs once per window, and a continuous stream still runs", async () => {
  let runs = 0;
  const run = coalesce(() => runs++, 30);
  for (let i = 0; i < 50; i++) run();
  expect(runs).toBe(0);
  await Bun.sleep(45);
  expect(runs).toBe(1);
  // Calls every 5 ms for ~100 ms: a debounce would never fire; this fires about three times.
  const until = Date.now() + 100;
  while (Date.now() < until) {
    run();
    await Bun.sleep(5);
  }
  await Bun.sleep(45);
  expect(runs).toBeGreaterThanOrEqual(3);
  expect(runs).toBeLessThanOrEqual(6);
});

test("a refresh queue batches, dedupes, and lets a prefix cover the keys under it", async () => {
  const { refreshQueue } = await import("./coalesce.ts");
  const flushed: { key: readonly unknown[]; exact?: boolean }[][] = [];
  const add = refreshQueue((keys) => flushed.push(keys), 20);
  for (let i = 0; i < 100; i++) {
    add(["project", "p1", "generations"]);
    add(["project", "p1", "generations", "batches"]);
    add(["project", "p1"], true);
    add(["panel", `x${i % 3}`]);
  }
  expect(flushed.length).toBe(0);
  await Bun.sleep(35);
  expect(flushed.length).toBe(1);
  const keys = flushed[0]!.map((k) => JSON.stringify(k.key)).sort();
  // The exact project key does not cover anything; "generations" covers "generations/batches".
  expect(keys).toEqual(
    ['["panel","x0"]', '["panel","x1"]', '["panel","x2"]', '["project","p1","generations"]', '["project","p1"]'].sort(),
  );
});
