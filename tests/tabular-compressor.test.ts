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
});
