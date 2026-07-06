import { describe, expect, it } from "vitest";

import {
  compressSearch,
  parseSearchResults,
} from "../src/compressors/search.js";
import { createContentHash } from "../src/store/ccr.js";
import { searchFixture } from "./fixtures.js";

describe("search compressor", () => {
  it("parses grep and rg context lines", () => {
    const parsed = parseSearchResults("src/a.ts:10:match\nsrc/a.ts-11-context");

    expect(parsed).toEqual([
      { file: "src/a.ts", lineNumber: 10, content: "match" },
      { file: "src/a.ts", lineNumber: 11, content: "context" },
    ]);
  });

  it("keeps line numbers, priority matches, summaries, and retrieve marker", () => {
    const original = searchFixture();
    const hash = createContentHash(original);
    const result = compressSearch({
      content: original,
      hash,
      query: "auth error",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("src/auth.ts:35:ERROR auth token rejected");
    expect(result.output).toContain("[... and");
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);
    expect(result.output.length).toBeLessThan(original.length * 0.3);
  });

  it("does not drop priority matches when many files exceed the target", () => {
    const lines = Array.from({ length: 15 }, (_, fileIndex) =>
      Array.from({ length: 6 }, (_, matchIndex) => {
        const lineNumber = matchIndex + 1;
        const content =
          matchIndex === 5
            ? `ERROR auth failed in file ${fileIndex + 1}`
            : `context ${matchIndex + 1}`;
        return `src/file${fileIndex + 1}.ts:${lineNumber}:${content}`;
      }),
    ).flat();
    const original = lines.join("\n");
    const result = compressSearch({
      content: original,
      hash: createContentHash(original),
      query: "auth error",
    });

    for (let fileIndex = 1; fileIndex <= 15; fileIndex += 1) {
      expect(result.output).toContain(
        `src/file${fileIndex}.ts:6:ERROR auth failed in file ${fileIndex}`,
      );
    }
  });
});
