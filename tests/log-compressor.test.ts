import { describe, expect, it } from "vitest";

import {
  classifyLogLine,
  classifyLogLines,
  compressLog,
  detectLogFormat,
  normalizeLogLineForDedupe,
} from "../src/compressors/log.js";
import { createContentHash } from "../src/store/ccr.js";
import { logFixture } from "./fixtures.js";

describe("log compressor", () => {
  it("classifies levels and formats", () => {
    expect(classifyLogLine("ERROR bad").level).toBe("ERROR");
    expect(classifyLogLine("npm ERR! bad").level).toBe("ERROR");
    expect(classifyLogLine("warning: unused").level).toBe("WARN");
    expect(detectLogFormat(["npm ERR! bad"])).toBe("npm");
    expect(
      detectLogFormat(["PASS src/a.test.ts", "Test Suites: 1 failed"]),
    ).toBe("jest");
  });

  it("keeps errors, stack traces, summaries, and retrieve marker", () => {
    const original = logFixture();
    const hash = createContentHash(original);
    const result = compressLog({
      content: original,
      hash,
      query: "auth failure",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("ERROR critical auth failure");
    expect(result.output).toContain("Traceback (most recent call last)");
    expect(result.output).toContain("2 failed, 1 warning");
    expect(result.output).toContain(`[Retrieve more: hash=${hash}]`);
    expect(result.output.length).toBeLessThan(original.length * 0.5);
  });

  it("leaves short logs unchanged", () => {
    const original = "INFO boot\nERROR short failure";
    const result = compressLog({
      content: original,
      hash: createContentHash(original),
      query: "failure",
    });

    expect(result).toEqual({
      changed: false,
      output: original,
      strategy: "log",
      reason: "too_few_lines",
    });
  });

  it("keeps chained Python tracebacks across blank lines", () => {
    const lines = [
      "Traceback (most recent call last):",
      '  File "a.py", line 1, in <module>',
      "ValueError: x",
      "",
      "During handling of the above exception, another exception occurred:",
      "",
      "Traceback (most recent call last):",
      '  File "b.py", line 2, in <module>',
      "RuntimeError: y",
    ];

    expect(classifyLogLines(lines)).toEqual(
      lines.map((line, index) =>
        expect.objectContaining({
          index,
          content: line,
          stackTrace: true,
        }),
      ),
    );
  });

  it("dedupes warnings conservatively after the message prefix", () => {
    expect(
      normalizeLogLineForDedupe("warning: file /tmp/a/123 issue"),
    ).toBe(normalizeLogLineForDedupe("warning: file /tmp/b/999 issue"));
    expect(
      normalizeLogLineForDedupe("segfault at 0xdeadbeef in thread main"),
    ).not.toBe(
      normalizeLogLineForDedupe("heap overflow at 0xcafef00d in thread worker"),
    );
  });
});
