import { describe, expect, it } from "vitest";

import { compressDiff } from "../src/compressors/diff.js";
import { compressByContentType } from "../src/engine/router.js";

const hash = "0123456789abcdef01234567";

function diffFixture(): string {
  return Array.from({ length: 45 }, (_, index) => [
    `diff --git a/src/value-${index}.ts b/src/value-${index}.ts`,
    `--- a/src/value-${index}.ts`,
    `+++ b/src/value-${index}.ts`,
    `@@ -1,5 +1,5 @@ export function value${index}() {`,
    "   const unchangedBefore = true;",
    `-  return ${index};`,
    `+  return ${index + 1};`,
    "   const unchangedAfter = true;",
  ].join("\n")).join("\n");
}

describe("diff compressor", () => {
  it("preserves every file header, hunk header, addition, and deletion", () => {
    const original = diffFixture();
    const result = compressDiff({ content: original, hash, query: "value 23" });

    expect(result.changed).toBe(true);
    for (const line of original.split("\n").filter((line) =>
      line.startsWith("diff --git ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("@@ ") ||
      (line.startsWith("+") && !line.startsWith("+++")) ||
      (line.startsWith("-") && !line.startsWith("---")),
    )) {
      expect(result.output).toContain(line);
    }
    expect(result.output).not.toContain("const unchangedBefore");
    expect(result.output).toContain("90 unchanged context lines omitted");
    expect(result.output).toContain("[Retrieve more: hash=");
  });

  it("routes diffs through the diff strategy", () => {
    const result = compressByContentType({
      content: diffFixture(),
      hash,
      query: "value 23",
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("diff");
  });

  it("leaves malformed and small diffs unchanged", () => {
    const original = "@@ not a valid hunk\n-old\n+new";
    expect(compressDiff({ content: original, hash, query: "" })).toMatchObject({
      changed: false,
      output: original,
    });
  });
});
