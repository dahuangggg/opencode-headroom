import { describe, expect, it } from "vitest";

import {
  compressSearch,
  parseSearchResults,
} from "../src/compressors/search.js";
import { compressionProfileForStrength } from "../src/compressors/profile.js";
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

  it("parses ripgrep heading-form rows", () => {
    const parsed = parseSearchResults(
      "src/a.ts\n10:match\n11:more context\nsrc/b.ts\n4:error",
    );

    expect(parsed).toEqual([
      { file: "src/a.ts", lineNumber: 10, content: "match" },
      { file: "src/a.ts", lineNumber: 11, content: "more context" },
      { file: "src/b.ts", lineNumber: 4, content: "error" },
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
    expect(result.output).toContain("[omitted:");
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

  it("keeps a priority match from a file beyond the first fifteen", () => {
    const lines = Array.from({ length: 16 }, (_, fileIndex) =>
      Array.from({ length: 6 }, (_, matchIndex) => {
        const fileNumber = fileIndex + 1;
        const lineNumber = matchIndex + 1;
        const content =
          fileNumber === 16 && matchIndex === 5
            ? "FATAL database corruption detected"
            : `context ${fileNumber}-${lineNumber}`;
        return `src/file${fileNumber}.ts:${lineNumber}:${content}`;
      }),
    ).flat();
    const original = lines.join("\n");

    const result = compressSearch({
      content: original,
      hash: createContentHash(original),
      query: "",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain(
      "src/file16.ts:6:FATAL database corruption detected",
    );
  });

  it("ranks all files before spending the filler file budget", () => {
    const lines = Array.from({ length: 20 }, (_, fileIndex) =>
      Array.from({ length: 4 }, (_, matchIndex) => {
        const fileNumber = fileIndex + 1;
        const lineNumber = matchIndex + 1;
        const content =
          fileNumber === 20 && matchIndex === 2
            ? "needle appears once"
            : `routine context ${fileNumber}-${lineNumber}`;
        return `src/file${fileNumber}.ts:${lineNumber}:${content}`;
      }),
    ).flat();
    const original = lines.join("\n");

    const result = compressSearch({
      content: original,
      hash: createContentHash(original),
      query: "needle",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("src/file20.ts:3:needle appears once");
  });

  it("reports omitted matches from every file consistently with debug counts", () => {
    const lines = Array.from({ length: 16 }, (_, fileIndex) =>
      Array.from({ length: 6 }, (_, matchIndex) => {
        const fileNumber = fileIndex + 1;
        const lineNumber = matchIndex + 1;
        const content =
          fileNumber === 16 && matchIndex === 5
            ? "ERROR final file failed"
            : `context ${fileNumber}-${lineNumber}`;
        return `src/file${fileNumber}.ts:${lineNumber}:${content}`;
      }),
    ).flat();
    const original = lines.join("\n");

    const result = compressSearch({
      content: original,
      hash: createContentHash(original),
      query: "",
    });
    const summarizedOmissions = [...result.output.matchAll(
      /(?:\[omitted:\s*|;\s*)(\d+)@[^;\]]+/g,
    )].reduce((total, match) => total + Number(match[1]), 0);

    expect(result.changed).toBe(true);
    expect(result.output).toContain(
      "2@src/file16.ts",
    );
    expect(summarizedOmissions).toBe(
      result.debug?.compressor?.dropped.matches,
    );
  });

  it("passes through when globally required matches leave no savings", () => {
    const original = Array.from(
      { length: 20 },
      (_, index) =>
        `src/file${index + 1}.ts:1:ERROR required failure ${index + 1}`,
    ).join("\n");

    const result = compressSearch({
      content: original,
      hash: createContentHash(original),
      query: "",
    });

    expect(result.changed).toBe(false);
    expect(result.reason).toBe("no_savings");
    expect(result.output).toBe(original);
    expect(result.debug?.compressor?.kept.requiredMatches).toBe(20);
    expect(result.debug?.compressor?.dropped.matches).toBe(0);
  });

  it("uses information saturation to keep less repetitive filler", () => {
    const buildResults = (diverse: boolean) =>
      Array.from({ length: 12 }, (_, fileIndex) =>
        Array.from({ length: 8 }, (_, matchIndex) => {
          const detail = diverse
            ? `symbol-${fileIndex * 101 + matchIndex * 17} changed package-${fileIndex}-${matchIndex}`
            : "generated cache entry has the same routine status";
          return `src/file${fileIndex + 1}.ts:${matchIndex + 1}:${detail}`;
        }),
      ).flat().join("\n");
    const compress = (content: string) =>
      compressSearch({
        content,
        hash: createContentHash(content),
        query: "",
      });
    const repeated = compress(buildResults(false));
    const diverse = compress(buildResults(true));
    const repeatedAdaptive = repeated.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;
    const diverseAdaptive = diverse.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;

    expect(repeatedAdaptive).toBeDefined();
    expect(diverseAdaptive).toBeDefined();
    expect(repeatedAdaptive?.k).toBeLessThan(diverseAdaptive?.k ?? 0);
    expect(repeatedAdaptive?.uniqueGroups).toBeLessThan(
      diverseAdaptive?.uniqueGroups ?? 0,
    );
    expect(repeated.debug?.compressor?.kept.fillerMatches).toBeLessThan(
      diverse.debug?.compressor?.kept.fillerMatches as number,
    );
  });

  it("maps compression strength to a monotonic adaptive search budget", () => {
    const original = Array.from({ length: 16 }, (_, fileIndex) =>
      Array.from(
        { length: 8 },
        (_, matchIndex) =>
          `src/file${fileIndex + 1}.ts:${matchIndex + 1}:symbol-${fileIndex * 101 + matchIndex * 17} changed package-${fileIndex}-${matchIndex}`,
      ),
    ).flat().join("\n");
    const fillerCount = (
      strength: "conservative" | "balanced" | "aggressive",
    ) => {
      const result = compressSearch({
        content: original,
        hash: createContentHash(original),
        query: "",
        profile: compressionProfileForStrength(strength),
      });
      return result.debug?.compressor?.kept.fillerMatches as number;
    };

    expect(fillerCount("conservative")).toBeGreaterThanOrEqual(
      fillerCount("balanced"),
    );
    expect(fillerCount("balanced")).toBeGreaterThanOrEqual(
      fillerCount("aggressive"),
    );
  });
});
