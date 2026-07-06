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
});
