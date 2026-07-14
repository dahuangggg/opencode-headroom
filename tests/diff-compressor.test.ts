import { describe, expect, it } from "vitest";

import { compressDiff } from "../src/compressors/diff.js";
import { compressByContentType } from "../src/engine/router.js";

const hash = "0123456789abcdef01234567";

function diffFixture(fileCount = 45): string {
  return Array.from({ length: fileCount }, (_, index) => [
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

function ordinaryDiffFixture(): string {
  return [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "index 1111111..2222222 100644",
    "--- a/src/auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,45 +1,45 @@ export async function authenticate() {",
    ...Array.from({ length: 9 }, (_, index) => [
      ` context before ${index}`,
      `-  const value${index} = legacy(${index});`,
      `+  const value${index} = rotate(${index});`,
      ` context after ${index}`,
      ` context separator ${index}`,
    ]).flat(),
  ].join("\n");
}

function largeSingleHunkFixture(): string {
  return [
    "diff --git a/src/auth.ts b/src/auth.ts",
    "old mode 100644",
    "new mode 100755",
    "similarity index 98%",
    "rename from src/legacy-auth.ts",
    "rename to src/auth.ts",
    "index 1111111..2222222 100755",
    "--- a/src/legacy-auth.ts",
    "+++ b/src/auth.ts",
    "@@ -1,45 +1,45 @@ export function authenticate() {",
    ...Array.from({ length: 18 }, (_, index) => ` far before ${index}`),
    " near before one",
    " near before two",
    "-  return legacyAuthenticate();",
    "+  return rotateCredential();",
    " near after one",
    " near after two",
    ...Array.from({ length: 18 }, (_, index) => ` far after ${index}`),
    "\\ No newline at end of file",
  ].join("\n");
}

function manyHunksFixture(): string {
  return [
    "diff --git a/src/service.ts b/src/service.ts",
    "index 1111111..2222222 100644",
    "--- a/src/service.ts",
    "+++ b/src/service.ts",
    ...Array.from({ length: 13 }, (_, index) => [
      `@@ -${index * 20 + 1},10 +${index * 20 + 1},10 @@ function routine${index}() {`,
      ...Array.from({ length: 4 }, (_, context) => ` before ${index}-${context}`),
      `-  return legacy${index}();`,
      index === 10
        ? "+  throw new SecurityAuthError('credential rotation failed');"
        : `+  return current${index}();`,
      ...Array.from({ length: 4 }, (_, context) => ` after ${index}-${context}`),
    ]).flat(),
  ].join("\n");
}

describe("diff compressor", () => {
  it("preserves ordinary diffs when bounded context would not save at least 20%", () => {
    const original = ordinaryDiffFixture();
    const result = compressDiff({ content: original, hash, query: "authenticate" });

    expect(result).toMatchObject({
      changed: false,
      output: original,
      reason: "insufficient_savings",
    });
  });

  it("keeps git metadata and two context lines around a changed region", () => {
    const original = largeSingleHunkFixture();
    const result = compressDiff({ content: original, hash, query: "rotate credential" });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("old mode 100644");
    expect(result.output).toContain("new mode 100755");
    expect(result.output).toContain("rename from src/legacy-auth.ts");
    expect(result.output).toContain("rename to src/auth.ts");
    expect(result.output).toContain(" near before one\n near before two");
    expect(result.output).toContain(" near after one\n near after two");
    expect(result.output).not.toContain(" far before 0");
    expect(result.output).not.toContain(" far after 17");
    expect(result.output).toContain("\\ No newline at end of file");
    expect(result.output).toContain("[Retrieve more: hash=");
  });

  it("preserves every file header, hunk header, addition, and deletion before caps engage", () => {
    const original = diffFixture(10);
    const result = compressDiff({ content: original, hash, query: "value 23" });

    expect(result.changed).toBe(false);
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
    expect(result.output).toContain("const unchangedBefore");
    expect(result.output).toContain("const unchangedAfter");
    expect(result.output).not.toContain("[Retrieve more: hash=");
  });

  it("caps large diffs at 20 files while retaining a query-matching file", () => {
    const original = diffFixture();
    const result = compressDiff({ content: original, hash, query: "value-23.ts" });

    expect(result.changed).toBe(true);
    expect(result.output.match(/^diff --git /gm)).toHaveLength(20);
    expect(result.output).toContain("diff --git a/src/value-23.ts b/src/value-23.ts");
    expect(result.debug?.compressor?.dropped.files).toBe(25);
  });

  it("keeps first, last, and relevant hunks when a file exceeds 10 hunks", () => {
    const original = manyHunksFixture();
    const result = compressDiff({
      content: original,
      hash,
      query: "security auth credential rotation",
    });

    expect(result.changed).toBe(true);
    expect(result.output.match(/^@@ /gm)).toHaveLength(10);
    expect(result.output).toContain("function routine0()");
    expect(result.output).toContain("function routine10()");
    expect(result.output).toContain("function routine12()");
    expect(result.output).not.toContain("function routine9()");
    expect(result.output).toContain("SecurityAuthError");
    expect(result.debug?.compressor?.dropped.hunks).toBe(3);
  });

  it("accepts bounded file selection through the router safety gate", () => {
    const result = compressByContentType({
      content: diffFixture(),
      hash,
      query: "value-23.ts",
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("diff");
    expect(result.output).toContain("diff --git a/src/value-23.ts b/src/value-23.ts");
  });

  it("routes diffs through the diff strategy", () => {
    const result = compressByContentType({
      content: largeSingleHunkFixture(),
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
