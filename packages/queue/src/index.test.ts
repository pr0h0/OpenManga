import { describe, expect, test } from "bun:test";
import { parseWorkerQueues, QUEUES } from "./index.ts";

describe("parseWorkerQueues", () => {
  test("empty means every queue", () => {
    expect(parseWorkerQueues("")).toEqual([...QUEUES]);
    expect(parseWorkerQueues(" , ")).toEqual([...QUEUES]);
  });
  test("a list is trimmed and deduplicated", () => {
    expect(parseWorkerQueues(" render ,render")).toEqual(["render"]);
    expect(parseWorkerQueues("export,text-ai")).toEqual(["text-ai", "export"]);
  });
  test("an unknown name fails loudly", () => {
    expect(() => parseWorkerQueues("render,videos")).toThrow("unknown queue videos");
  });
});
