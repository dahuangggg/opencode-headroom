import { describe, expect, it } from "vitest";

import {
  collapseRuns,
  compactLossless,
  expandRuns,
  searchHeading,
  searchUnheading,
} from "../src/engine/lossless.js";
import { compressByContentType } from "../src/engine/router.js";
import { createContentHash } from "../src/store/ccr.js";
import { searchFixture } from "./fixtures.js";

describe("lossless compaction", () => {
  it("round-trips repeated lines including a trailing newline", () => {
    const original = `${Array(12).fill("INFO waiting for worker").join("\n")}\n`;
    const compacted = collapseRuns(original);

    expect(compacted).toContain("... (repeated 12 times)");
    expect(compacted.length).toBeLessThan(original.length);
    expect(expandRuns(compacted)).toBe(original);
  });

  it("round-trips grep rows through ripgrep heading form", () => {
    const original = Array.from(
      { length: 20 },
      (_, index) => `src/auth/session.ts:${index + 1}:auth event ${index + 1}`,
    ).join("\n");
    const compacted = searchHeading(original);

    expect(compacted).toMatch(/^src\/auth\/session\.ts\n1:auth event 1/);
    expect(compacted.length).toBeLessThan(original.length);
    expect(searchUnheading(compacted)).toBe(original);
  });

  it("fails open when existing text makes a run marker ambiguous", () => {
    const original = "INFO one event\n... (repeated 3 times)";

    expect(compactLossless(original, "log")).toEqual({
      changed: false,
      output: original,
    });
  });

  it("does not expand an untrusted repeat count beyond the safety bound", () => {
    const untrusted = "INFO one event\n... (repeated 250001 times)";

    expect(expandRuns(untrusted)).toBe(untrusted);
  });

  it("uses a reversible fold as the floor when lossy compression passes through", () => {
    const original = Array(40).fill("INFO waiting for worker").join("\n");
    const input = {
      content: original,
      hash: createContentHash(original),
      query: "worker",
    };

    const withoutLossless = compressByContentType(input);
    const withLossless = compressByContentType(input, {
      losslessThenLossy: true,
    });

    expect(withoutLossless.changed).toBe(false);
    expect(withLossless.changed).toBe(true);
    expect(withLossless.output).toContain("... (repeated 40 times)");
    expect(expandRuns(withLossless.output)).toBe(original);
    expect(withLossless.debug?.lossless).toMatchObject({
      applied: true,
      transform: "runs",
    });
  });

  it("layers lossy search selection on top of heading compaction", () => {
    const original = searchFixture();
    const result = compressByContentType(
      {
        content: original,
        hash: createContentHash(original),
        query: "auth error",
      },
      { losslessThenLossy: true },
    );

    expect(result.changed).toBe(true);
    expect(result.output).toContain("src/auth.ts:35:ERROR auth token rejected");
    expect(result.output).toContain("[Retrieve more: hash=");
    expect(result.debug?.lossless).toMatchObject({
      applied: true,
      transform: "search_heading",
    });
  });
});
