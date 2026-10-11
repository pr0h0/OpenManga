import { expect, test } from "bun:test";
import { QUEUES } from "./index.ts";
import { servableQueues, uncoveredQueues, type WorkerInfo, workerCapabilities } from "./workers.ts";

test("capabilities: detected plus declared, a declared minus takes one away, an unknown one throws", () => {
  expect(workerCapabilities("", ["ffmpeg", "tts"])).toEqual(["ffmpeg", "tts"]);
  expect(workerCapabilities("gpu, -ffmpeg", ["ffmpeg", "tts"])).toEqual(["tts", "gpu"]);
  expect(() => workerCapabilities("quantum", [])).toThrow(/unknown capability quantum/);
});

test("a worker without ffmpeg leaves video renders to one that has it, and says why", () => {
  const { consumed, refused } = servableQueues([...QUEUES], ["tts"]);
  expect(consumed).not.toContain("render");
  expect(consumed).toContain("export");
  expect(refused).toEqual([{ queue: "render", missing: ["ffmpeg"] }]);
});

test("queues nothing alive takes, with what waits and who refused them", () => {
  const w: WorkerInfo = {
    id: "a",
    host: "box",
    queues: QUEUES.filter((q) => q !== "render"),
    capabilities: [],
    refused: [{ queue: "render", missing: ["ffmpeg"] }],
    version: null,
    startedAt: "",
    lastSeen: "",
  };
  expect(uncoveredQueues([w], { render: { waiting: 2, delayed: 1 } })).toEqual([
    { queue: "render", waiting: 3, needs: ["ffmpeg"], refusedBy: [{ id: "a", host: "box" }] },
  ]);
});
