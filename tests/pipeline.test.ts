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
});
