import { describe, expect, it } from "vitest";

import { compressJson } from "../src/compressors/json.js";
import { createContentHash } from "../src/store/ccr.js";
import { largeJsonArrayFixture } from "./fixtures.js";

describe("JSON SmartCrusher-lite", () => {
  it("keeps original rows and appends Headroom CCR sentinel", () => {
    const original = largeJsonArrayFixture();
    const hash = createContentHash(original);
    const result = compressJson({
      content: original,
      hash,
      query: "auth error",
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("json");

    const parsed = JSON.parse(result.output) as Array<Record<string, unknown>>;
    expect(parsed[0]?.id).toBe(1);
    expect(
      parsed.some((row) => row.message === "auth failed for token refresh"),
    ).toBe(true);
    expect(parsed.some((row) => row.extra === "shape change")).toBe(true);
    expect(parsed.at(-1)).toEqual({
      _ccr_dropped: `<<ccr:${hash} 67_rows_offloaded>>`,
    });
    expect(result.output.length).toBeLessThan(original.length * 0.4);
  });

  it("passes invalid JSON through", () => {
    const result = compressJson({
      content: "[not json",
      hash: "0123456789abcdef01234567",
      query: "",
    });

    expect(result.changed).toBe(false);
    expect(result.output).toBe("[not json");
  });
});
