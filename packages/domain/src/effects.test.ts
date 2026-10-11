import { expect, test } from "bun:test";
import { PanelEffect } from "@openmanga/schemas";
import { effectLayer, effectLayers } from "./effects.ts";

test("every effect draws a deterministic SVG layer, blended as it should be", () => {
  const types = ["speed", "focus", "impact", "tone", "rain", "snow", "dust", "glow", "flashback"] as const;
  for (const type of types) {
    const e = PanelEffect.parse({ type });
    const a = effectLayer(e, 400, 300, "p1:0");
    expect(a.svg).toStartWith('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"');
    // Same panel and place: the same picture.
    expect(effectLayer(e, 400, 300, "p1:0").svg).toBe(a.svg);
  }
  expect(effectLayer(PanelEffect.parse({ type: "tone" }), 10, 10, "x").blend).toBe("multiply");
  expect(effectLayer(PanelEffect.parse({ type: "glow" }), 10, 10, "x").blend).toBe("screen");
  expect(effectLayer(PanelEffect.parse({ type: "flashback" }), 10, 10, "x").tint).toBe(true);
  // Another panel gets other lines; denser means more.
  const speed = PanelEffect.parse({ type: "speed", density: 0.2 });
  expect(effectLayer(speed, 400, 300, "p2:0").svg).not.toBe(effectLayer(speed, 400, 300, "p1:0").svg);
  const count = (s: string) => (s.match(/Z/g) ?? []).length;
  expect(count(effectLayer({ ...speed, density: 1 }, 400, 300, "p").svg)).toBeGreaterThan(
    count(effectLayer(speed, 400, 300, "p").svg),
  );
  expect(effectLayers(null, 10, 10, "p")).toEqual([]);
});
