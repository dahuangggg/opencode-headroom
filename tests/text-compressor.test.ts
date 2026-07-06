import { describe, expect, it } from "vitest";

import {
  compressText,
  scoreTextSegment,
  splitTextSegments,
} from "../src/compressors/text.js";
import { createContentHash } from "../src/store/ccr.js";
import { textFixture } from "./fixtures.js";

describe("extractive text compressor", () => {
  it("splits useful text segments", () => {
    expect(splitTextSegments("A.\n\nB.")).toEqual(["A.", "B."]);
    expect(splitTextSegments("A. B! C?")).toEqual(["A.", "B!", "C?"]);
  });

  it("scores query and salient segments above routine prose", () => {
    const queryWords = ["security", "auth"];

    expect(
      scoreTextSegment("Security warning: auth token rotation is required.", {
        index: 0,
        total: 2,
        queryWords,
      }),
    ).toBeGreaterThan(
      scoreTextSegment("The build processed many modules successfully.", {
        index: 0,
        total: 2,
        queryWords,
      }),
    );
  });

  it("keeps only original segments and appends retrieve marker", () => {
    const original = textFixture();
    const hash = createContentHash(original);
    const result = compressText({
      content: original,
      hash,
      query: "security auth",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("# Build Report");
    expect(result.output).toContain(
      "Security warning: auth token rotation is required.",
    );
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);
    expect(result.output.length).toBeLessThan(original.length * 0.7);

    for (const segment of result.output
      .split(/\n+/)
      .filter((part) => part && !part.startsWith("[Retrieve"))) {
      expect(original).toContain(segment);
    }
  });

  it("leaves short prose unchanged", () => {
    const original = "One sentence. Two sentences.";
    const result = compressText({
      content: original,
      hash: createContentHash(original),
      query: "sentence",
    });

    expect(result).toEqual({
      changed: false,
      output: original,
      strategy: "text",
      reason: "too_few_segments",
    });
  });
});
