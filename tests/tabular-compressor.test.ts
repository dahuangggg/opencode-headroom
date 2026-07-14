import { describe, expect, it } from "vitest";

import { compressTabular } from "../src/compressors/tabular.js";
import { compressByContentType, detectContentType } from "../src/engine/router.js";

const hash = "0123456789abcdef01234567";

function markdownTable(): string {
  return [
    "| tenant | status | action |",
    "| --- | --- | --- |",
    ...Array.from({ length: 100 }, (_, index) =>
      index === 73
        ? "| tenant-critical | ERROR | rotate-before-publish |"
        : `| tenant-${index} | ok | none |`,
    ),
  ].join("\n");
}

describe("tabular compressor", () => {
  it("keeps headers, abnormal rows, query matches, and boundary samples", () => {
    const original = markdownTable();
    const result = compressTabular({
      content: original,
      hash,
      query: "tenant-critical rotate publish",
    });

    expect(result.changed).toBe(true);
    expect(result.output).toContain("| tenant | status | action |");
    expect(result.output).toContain("| --- | --- | --- |");
    expect(result.output).toContain(
      "| tenant-critical | ERROR | rotate-before-publish |",
    );
    expect(result.output).toContain("| tenant-0 | ok | none |");
    expect(result.output).toContain("| tenant-99 | ok | none |");
    expect(result.output).toContain("rows omitted");
    expect(result.output).toContain("[Retrieve more: hash=");
  });

  it("detects and routes markdown tables", () => {
    const original = markdownTable();
    const result = compressByContentType({
      content: original,
      hash,
      query: "tenant-critical",
    });

    expect(detectContentType(original).kind).toBe("table");
    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("table");
  });

  it("supports CSV while leaving small tables unchanged", () => {
    const csv = [
      "tenant,status,action",
      ...Array.from({ length: 60 }, (_, index) =>
        index === 40
          ? "tenant-critical,ERROR,rotate-before-publish"
          : `tenant-${index},ok,none`,
      ),
    ].join("\n");
    expect(
      compressTabular({ content: csv, hash, query: "tenant-critical" }),
    ).toMatchObject({ changed: true, strategy: "table" });

    const small = "tenant,status\na,ok\nb,ok";
    expect(
      compressTabular({ content: small, hash, query: "" }),
    ).toMatchObject({ changed: false, output: small });
  });

  it("uses a smaller adaptive filler budget for repetitive tables", () => {
    const build = (diverse: boolean) => [
      "tenant,status,detail",
      ...Array.from({ length: 60 }, (_, index) =>
        diverse
          ? `tenant-${index},ok,distinct component ${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)} changed behavior`
          : `tenant-${index},ok,routine cache entry completed successfully`,
      ),
    ].join("\n");
    const repeated = compressTabular({ content: build(false), hash, query: "" });
    const diverse = compressTabular({ content: build(true), hash, query: "" });
    const repeatedAdaptive = repeated.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;
    const diverseAdaptive = diverse.debug?.compressor?.kept.adaptive as
      | { k: number; uniqueGroups: number }
      | undefined;

    expect(repeatedAdaptive).toBeDefined();
    expect(diverseAdaptive).toBeDefined();
    expect(repeatedAdaptive?.k).toBeLessThan(diverseAdaptive?.k ?? 0);
  });

  it("keeps a middle sample from a repetitive ordered table", () => {
    const original = [
      "tenant,status,detail",
      ...Array.from(
        { length: 41 },
        (_, index) =>
          `tenant-${index},ok,routine cache entry completed successfully`,
      ),
    ].join("\n");
    const result = compressTabular({ content: original, hash, query: "" });

    expect(result.output).toContain(
      "tenant-20,ok,routine cache entry completed successfully",
    );
  });

  it("keeps a semantically rare row without severity or query keywords", () => {
    const rows = Array.from(
      { length: 50 },
      (_, index) =>
        `tenant-${index},ok,routine cache entry completed successfully`,
    );
    rows[37] =
      "tenant-37,quarantined,credential signature expired during regional handoff";
    const original = ["tenant,status,detail", ...rows].join("\n");
    const result = compressTabular({ content: original, hash, query: "" });

    expect(result.output).toContain(rows[37]);
  });

  it("keeps a numeric outlier without severity or query keywords", () => {
    const rows = Array.from(
      { length: 50 },
      (_, index) => `tenant-${index},100,ok`,
    );
    rows[33] = "tenant-33,5000,ok";
    const original = ["tenant,latency_ms,status", ...rows].join("\n");
    const result = compressTabular({ content: original, hash, query: "" });

    expect(result.output).toContain(rows[33]);
  });
});
