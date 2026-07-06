import { describe, expect, it } from "vitest";

import {
  detectContentType,
  stripDetectionEnvelope,
} from "../src/engine/router.js";

describe("content router detection", () => {
  it("strips full tool output envelopes for detection only", () => {
    const wrapped =
      "<returncode>0</returncode>\n<output>\nsrc/a.ts:10:match\n</output>";

    expect(stripDetectionEnvelope(wrapped)).toBe("src/a.ts:10:match");
  });

  it("detects JSON arrays and objects", () => {
    expect(detectContentType('[{"id":1}]').kind).toBe("json");
    expect(detectContentType('{"id":1}').kind).toBe("json");
  });

  it("detects diff before search", () => {
    const diff =
      "diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\n+src/a.ts:10:still diff";

    expect(detectContentType(diff).kind).toBe("diff");
  });

  it("detects search output", () => {
    const result = detectContentType(
      "src/a.ts:10:const x = 1;\nsrc/a.ts:20:const y = 2;",
    );

    expect(result.kind).toBe("search");
  });

  it("detects logs", () => {
    const result = detectContentType(
      "2026-01-01 starting\nERROR failed\nWARNING retrying",
    );

    expect(result.kind).toBe("log");
  });

  it("does not treat ISO timestamps as search results", () => {
    expect(
      detectContentType("2026-01-01 10:22:33 ERROR failed").kind,
    ).toBe("log");
    expect(
      detectContentType("2026-01-01T10:22:33Z ERROR failed").kind,
    ).toBe("log");
  });

  it("falls back to text", () => {
    expect(detectContentType("plain prose with no strong structure").kind).toBe(
      "text",
    );
  });
});
