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
