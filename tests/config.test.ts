import { describe, expect, it } from "vitest";

import { normalizeConfig, shouldSkipTool } from "../src/config.js";

describe("normalizeConfig", () => {
  it("applies P0 defaults", () => {
    const config = normalizeConfig();

    expect(config.engine).toBe("native");
    expect(config.thresholdTokens).toBe(2000);
    expect(config.thresholdChars).toBe(8000);
    expect(config.ttlHours).toBe(24);
    expect(config.storage).toEqual({
      kind: "auto",
      path: ".headroom/ccr.sqlite",
    });
    expect(config.skipTools).toEqual(["headroom_*", "ctx_*"]);
    expect(config.maxOutputChars).toBe(250000);
    expect(config.debug).toBe(false);
  });

  it("rejects unsupported engines", () => {
    expect(() => normalizeConfig({ engine: "headroom-http" as never })).toThrow(
      /Unsupported engine/,
    );
  });
});

describe("shouldSkipTool", () => {
  it("supports exact names and trailing-star prefix patterns", () => {
    const config = normalizeConfig({ skipTools: ["ctx_*", "Read"] });

    expect(shouldSkipTool("ctx_search", config)).toBe(true);
    expect(shouldSkipTool("Read", config)).toBe(true);
    expect(shouldSkipTool("Bash", config)).toBe(false);
  });
});
