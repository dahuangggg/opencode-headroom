import { describe, expect, it } from "vitest";

import { gateCompressionCandidate } from "../src/engine/pipeline.js";

describe("compression candidate gate", () => {
  it("accepts a smaller candidate that preserves protected facts", () => {
    const original = [
      "INFO routine setup completed",
      "ERROR auth failed at src/auth.ts:93",
      ...Array.from({ length: 30 }, (_, index) => `INFO routine ${index}`),
    ].join("\n");
    const candidate = [
      "ERROR auth failed at src/auth.ts:93",
      "[Retrieve more: hash=0123456789abcdef01234567]",
    ].join("\n");

    expect(
      gateCompressionCandidate({ original, candidate, kind: "log" }),
    ).toMatchObject({ accepted: true });
  });

  it("rejects a smaller candidate that drops an error or stack location", () => {
    const original = [
      "ERROR auth failed",
      '  File "auth.py", line 93, in rotate',
      ...Array.from({ length: 30 }, (_, index) => `INFO routine ${index}`),
    ].join("\n");

    expect(
      gateCompressionCandidate({
        original,
        candidate: "ERROR auth failed",
        kind: "log",
      }),
    ).toMatchObject({ accepted: false, reason: "protected_fact_lost" });
  });

  it("rejects invalid structured output and candidates without token savings", () => {
    expect(
      gateCompressionCandidate({
        original: JSON.stringify({ rows: Array.from({ length: 50 }, (_, id) => ({ id })) }),
        candidate: "{invalid",
        kind: "json",
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_structure" });

    expect(
      gateCompressionCandidate({
        original: "ERROR auth failed",
        candidate: "ERROR auth failed",
        kind: "text",
      }),
    ).toMatchObject({ accepted: false, reason: "no_token_savings" });
  });

  it("tracks protected JSON scalar values without requiring original whitespace", () => {
    const original = JSON.stringify({
      rows: [
        { id: 1, message: "routine" },
        { id: 2, message: "ERROR auth refresh rejected" },
        ...Array.from({ length: 50 }, (_, id) => ({ id: id + 3, message: "routine" })),
      ],
    });
    const candidate = JSON.stringify(
      { rows: [{ id: 2, message: "ERROR auth refresh rejected" }] },
      null,
      2,
    );

    expect(
      gateCompressionCandidate({ original, candidate, kind: "json" }),
    ).toMatchObject({ accepted: true });
  });

  it("protects the salient sentence instead of an entire long prose line", () => {
    const protectedSentence =
      "Security warning: long-line credential validation failed.";
    const original = [
      protectedSentence,
      ...Array.from(
        { length: 40 },
        (_, index) => `Routine sentence ${index} carries stable filler.`,
      ),
    ].join(" ");
    const candidate = `${protectedSentence}\nRoutine sentence 39 carries stable filler.`;

    expect(
      gateCompressionCandidate({
        original,
        candidate,
        kind: "text",
      }),
    ).toMatchObject({ accepted: true });
  });

  it("allows ordinary diff omissions but still hard-protects security changes", () => {
    const original = [
      "diff --git a/src/auth.ts b/src/auth.ts",
      "--- a/src/auth.ts",
      "+++ b/src/auth.ts",
      "@@ -1,3 +1,3 @@",
      "-export const routine = false;",
      "+throw new SecurityAuthError('credential rotation failed');",
      ...Array.from({ length: 40 }, (_, index) => ` context ${index}`),
    ].join("\n");
    const candidate = [
      "diff --git a/src/routine.ts b/src/routine.ts",
      "--- a/src/routine.ts",
      "+++ b/src/routine.ts",
      "@@ -1 +1 @@",
      "+export const routine = true;",
    ].join("\n");

    expect(
      gateCompressionCandidate({ original, candidate, kind: "diff" }),
    ).toMatchObject({ accepted: false, reason: "protected_fact_lost" });
  });

  it("rejects a diff candidate without a hunk and changed line", () => {
    const original = [
      "diff --git a/src/value.ts b/src/value.ts",
      "--- a/src/value.ts",
      "+++ b/src/value.ts",
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
      ...Array.from({ length: 40 }, (_, index) => ` context ${index}`),
    ].join("\n");

    expect(
      gateCompressionCandidate({
        original,
        candidate: "diff --git a/src/value.ts b/src/value.ts",
        kind: "diff",
      }),
    ).toMatchObject({ accepted: false, reason: "invalid_structure" });
  });
});
