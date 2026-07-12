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

  it("never drops priority rows when required rows exceed the target", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      id: index + 1,
      level: "INFO",
      message: `normal event ${index + 1}`,
      service: "api",
    }));
    for (let index = 1; index <= 13; index += 1) {
      rows[index] = { ...rows[index], extra: `shape change ${index}` };
    }
    rows[34] = {
      ...rows[34],
      level: "ERROR",
      message: "auth failed for token refresh",
    };
    const original = JSON.stringify(rows, null, 2);
    const result = compressJson({
      content: original,
      hash: createContentHash(original),
      query: "auth error",
    });

    const parsed = JSON.parse(result.output) as Array<Record<string, unknown>>;

    expect(parsed.some((row) => row.id === 35)).toBe(true);
    expect(
      parsed.some((row) => row.message === "auth failed for token refresh"),
    ).toBe(true);
  });

  it("compresses a nested results array without losing object metadata or priority rows", () => {
    const priorityRow = {
      id: 31,
      level: "ERROR",
      message: "database connection failed",
    };
    const originalValue = {
      total: 40,
      nextCursor: "page-2",
      results: Array.from({ length: 40 }, (_, index) =>
        index === 30
          ? priorityRow
          : {
              id: index + 1,
              level: "INFO",
              message: `event ${index + 1}`,
            },
      ),
    };
    const original = JSON.stringify(originalValue, null, 2);
    const hash = createContentHash(original);

    const result = compressJson({
      content: original,
      hash,
      query: "",
    });
    const parsed = JSON.parse(result.output) as typeof originalValue;

    expect(result.changed).toBe(true);
    expect(parsed.total).toBe(40);
    expect(parsed.nextCursor).toBe("page-2");
    expect(parsed.results).toContainEqual(priorityRow);
    expect(parsed.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _ccr_dropped: expect.stringMatching(
            new RegExp(`^<<ccr:${hash} \\d+_rows_offloaded>>$`),
          ),
        }),
      ]),
    );
  });

  it.each(["data", "items"] as const)(
    "compresses a common nested %s array in place",
    (key) => {
      const rows = Array.from({ length: 30 }, (_, index) => ({
        id: index + 1,
        status: "ok",
        message: `event ${index + 1}`,
      }));
      const original = JSON.stringify({ requestId: "req-1", [key]: rows }, null, 2);
      const hash = createContentHash(original);

      const result = compressJson({ content: original, hash, query: "" });
      const parsed = JSON.parse(result.output) as Record<string, unknown>;
      const compressedRows = parsed[key] as Array<Record<string, unknown>>;

      expect(result.changed).toBe(true);
      expect(parsed.requestId).toBe("req-1");
      expect(compressedRows[0]).toEqual(rows[0]);
      expect(compressedRows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            _ccr_dropped: expect.stringMatching(
              new RegExp(`^<<ccr:${hash} \\d+_rows_offloaded>>$`),
            ),
          }),
        ]),
      );
    },
  );

  it("summarizes a large top-level object without dropping priority fields", () => {
    const entries = Array.from({ length: 40 }, (_, index) => [
      `field${String(index + 1).padStart(2, "0")}`,
      `routine value ${index + 1}`,
    ] as const);
    entries[30] = ["errorMessage", "FATAL database unavailable"];
    const originalValue = Object.fromEntries(entries);
    const original = JSON.stringify(originalValue, null, 2);
    const hash = createContentHash(original);

    const result = compressJson({ content: original, hash, query: "" });
    const parsed = JSON.parse(result.output) as Record<string, unknown>;

    expect(result.changed).toBe(true);
    expect(parsed.field01).toBe("routine value 1");
    expect(parsed.field40).toBe("routine value 40");
    expect(parsed.errorMessage).toBe("FATAL database unavailable");
    expect(parsed._ccr_dropped).toMatch(
      new RegExp(`^<<ccr:${hash} \\d+_fields_offloaded>>$`),
    );
    expect(Object.keys(parsed).length).toBeLessThan(Object.keys(originalValue).length);
  });
});
