import { expect, test } from "bun:test";
import { documentTitle } from "./title.ts";

test("page, project and app name, in that order", () => {
  expect(documentTitle("Cast", { title: "Night Bus", film: false })).toBe("Cast · Night Bus · OpenManga");
});

test("outside a project only the page is named", () => {
  expect(documentTitle("Projects")).toBe("Projects · OpenManga");
  expect(documentTitle(undefined)).toBe("OpenManga");
});

test("film projects say Shots, matching the sidebar", () => {
  const film = { title: "Night Bus", film: true };
  expect(documentTitle("Pages", film)).toBe("Shots · Night Bus · OpenManga");
  expect(documentTitle("Page editor", film)).toBe("Shot editor · Night Bus · OpenManga");
  // Only those two are renamed.
  expect(documentTitle("Cast", film)).toBe("Cast · Night Bus · OpenManga");
});
