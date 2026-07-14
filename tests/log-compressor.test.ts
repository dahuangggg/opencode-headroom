import { describe, expect, it } from "vitest";

import {
  classifyLogLine,
  classifyLogLines,
  compressLog,
  detectLogFormat,
  normalizeLogLineForDedupe,
} from "../src/compressors/log.js";
import { compressionProfileForStrength } from "../src/compressors/profile.js";
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

  it("keeps query-matching lines with nearby context", () => {
    const original = Array.from({ length: 100 }, (_, index) =>
      index === 61
        ? "INFO tenant-lilac credential rotation started"
        : `INFO routine worker event ${index}`,
    ).join("\n");
    const result = compressLog({
      content: original,
      hash: createContentHash(original),
      query: "tenant-lilac credential",
      profile: compressionProfileForStrength("aggressive"),
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain(
      "INFO tenant-lilac credential rotation started",
    );
    expect(result.output).toContain("INFO routine worker event 60");
    expect(result.output).toContain("INFO routine worker event 62");
  });

  it("keeps every query match when matches exceed the normal line budget", () => {
    const original = Array.from({ length: 100 }, (_, index) =>
      index < 70
        ? `INFO tenant-lilac shard ${index} completed`
        : `INFO routine worker event ${index}`,
    ).join("\n");
    const result = compressLog({
      content: original,
      hash: createContentHash(original),
      query: "tenant-lilac",
      profile: compressionProfileForStrength("aggressive"),
    });

    expect(result.changed).toBe(true);
    expect(result.debug?.compressor?.kept.requiredLines).toBe(70);
    expect(result.output.match(/tenant-lilac/g)).toHaveLength(70);
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

  it("uses information saturation to keep less repetitive log filler", () => {
    const buildLog = (diverse: boolean) =>
      Array.from({ length: 100 }, (_, index) => {
        if (index % 10 === 5) {
          return diverse
            ? `WARN worker-${index}: distinct subsystem-${index} state-${index * 17}`
            : `WARN worker-${index}: generated cache entry has the same routine status`;
        }
        return diverse
          ? `INFO symbol-${index * 101} changed package-${index % 13}`
          : "INFO generated cache entry has the same routine status";
      }).join("\n");
    const compress = (content: string) =>
      compressLog({
        content,
        hash: createContentHash(content),
        query: "",
      });
    const repeated = compress(buildLog(false));
    const diverse = compress(buildLog(true));
    const repeatedAdaptive = repeated.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;
    const diverseAdaptive = diverse.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;

    expect(repeatedAdaptive).toBeDefined();
    expect(diverseAdaptive).toBeDefined();
    expect(repeatedAdaptive?.k).toBeLessThan(diverseAdaptive?.k ?? 0);
    expect(repeated.debug?.compressor?.kept.fillerLines).toBeLessThan(
      diverse.debug?.compressor?.kept.fillerLines as number,
    );
  });

  it("keeps required summaries even when they exceed the total line ceiling", () => {
    const original = Array.from(
      { length: 80 },
      (_, index) => `Summary shard ${index}: completed with status ${index}`,
    ).join("\n");
    const result = compressLog({
      content: original,
      hash: createContentHash(original),
      query: "",
      profile: compressionProfileForStrength("aggressive"),
    });

    expect(result.output).toBe(original);
    expect(result.debug?.compressor?.kept.requiredLines).toBe(80);
    expect(result.debug?.compressor?.dropped.lines).toBe(0);
  });

  it("maps compression strength to a monotonic adaptive log budget", () => {
    const original = Array.from({ length: 160 }, (_, index) => {
      if (index % 12 === 6) {
        return `WARN worker-${index}: subsystem-${index} changed state-${index * 17}`;
      }
      return `INFO symbol-${index * 101} changed package-${index % 17}`;
    }).join("\n");
    const fillerCount = (
      strength: "conservative" | "balanced" | "aggressive",
    ) => {
      const result = compressLog({
        content: original,
        hash: createContentHash(original),
        query: "",
        profile: compressionProfileForStrength(strength),
      });
      return result.debug?.compressor?.kept.fillerLines as number;
    };

    expect(fillerCount("conservative")).toBeGreaterThanOrEqual(
      fillerCount("balanced"),
    );
    expect(fillerCount("balanced")).toBeGreaterThanOrEqual(
      fillerCount("aggressive"),
    );
  });
});
