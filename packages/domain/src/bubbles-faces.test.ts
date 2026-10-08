import { expect, test } from "bun:test";
import { coveredFaces, facesOnPage, tailTowardFace } from "./bubbles.ts";

test("faces map through the panel crop onto the page; cropped-out faces are dropped", () => {
  // A 1000x1000 image shown in a frame of half the page width, cropped to its left half.
  const frame = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 };
  const crop = { left: 0, top: 0, width: 500, height: 1000 };
  const [face, gone] = [
    { name: "Ines", x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    { name: "Tomas", x: 0.7, y: 0.1, width: 0.2, height: 0.2 },
  ];
  const out = facesOnPage([face!, gone!], frame, { width: 1000, height: 1000 }, crop, 0);
  expect(out).toHaveLength(1);
  expect(out[0]!.name).toBe("Ines");
  // u 0.2..0.6 of the crop → x 0.1 + 0.4*0.2 = 0.18, width 0.16; v 0.1..0.3 → y 0.23, height 0.06.
  expect(out[0]!.x).toBeCloseTo(0.18);
  expect(out[0]!.width).toBeCloseTo(0.16);
  expect(out[0]!.y).toBeCloseTo(0.23);
  expect(out[0]!.height).toBeCloseTo(0.06);
});

test("a tail ends on the face edge nearest its bubble", () => {
  const face = { x: 0.4, y: 0.5, width: 0.2, height: 0.2 };
  expect(tailTowardFace({ x: 0.05, y: 0.05, width: 0.2, height: 0.1 }, face)).toEqual({ x: 0.4, y: 0.5 });
  expect(tailTowardFace({ x: 0.45, y: 0.1, width: 0.1, height: 0.1 }, face)).toEqual({ x: 0.5, y: 0.5 });
});

test("coveredFaces: a bubble over most of a face covers it, a bubble at its edge does not", () => {
  const face = { name: "Mina", x: 0.2, y: 0.2, width: 0.1, height: 0.1 };
  expect(coveredFaces([face], [{ x: 0.22, y: 0.18, width: 0.2, height: 0.08 }]).map((f) => f.name)).toEqual(["Mina"]);
  expect(coveredFaces([face], [{ x: 0.28, y: 0.2, width: 0.2, height: 0.1 }])).toEqual([]);
  expect(coveredFaces([face], [])).toEqual([]);
});
