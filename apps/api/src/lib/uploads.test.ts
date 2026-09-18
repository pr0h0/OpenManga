import { expect, test } from "bun:test";
import { InvalidImageError, sanitizeUpload } from "@openmanga/image-utils";

/**
 * Every unreadable upload must be an InvalidImageError, which the route turns into a 415. The second case is the
 * one that reached production as a 500: a PNG whose header parses (so `metadata()` succeeds) but whose pixel
 * data the encoder cannot read.
 */
test("a file that is not an image is rejected", async () => {
  await expect(sanitizeUpload(new TextEncoder().encode("hello, not an image"))).rejects.toBeInstanceOf(
    InvalidImageError,
  );
});

test("a PNG with a readable header but undecodable pixels is rejected, not thrown raw", async () => {
  // Captured from a live 500: sniffs as PNG, metadata reads, `toBuffer` fails with "libpng read error".
  const corrupt = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAF0lEQVR4nGP8//8/AzGAiShVowZTx2AAtwMDATz7wxAAAAAASUVORK5CYII=",
    "base64",
  );
  await expect(sanitizeUpload(new Uint8Array(corrupt))).rejects.toBeInstanceOf(InvalidImageError);
});
