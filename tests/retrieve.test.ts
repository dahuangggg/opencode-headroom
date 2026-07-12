import { describe, expect, it } from "vitest";

import { retrieveEntry } from "../src/engine/retrieve.js";
import type { CCREntry } from "../src/store/types.js";

function entry(originalContent: string, strategy = "text"): CCREntry {
  return {
    hash: "0123456789abcdef01234567",
    sessionID: "session-1",
    callID: "call-1",
    tool: "Bash",
    strategy,
    originalContent,
    compressedContent: "compressed",
    originalTokens: Math.ceil(originalContent.length / 4),
    compressedTokens: 3,
    originalChars: originalContent.length,
    compressedChars: 10,
    createdAt: 1,
    expiresAt: 2,
    retrievalCount: 0,
  };
}

describe("partial CCR retrieval", () => {
  it("matches a CJK query without ASCII word boundaries", () => {
    const output = retrieveEntry(
      entry("服务启动正常\n数据库连接失败，请检查配置\n准备重试"),
      {
        mode: "query",
        query: "失败",
        contextLines: 0,
        maxChars: 1000,
      },
    );

    expect(output).toContain("数据库连接失败，请检查配置");
    expect(output).toContain("matches: 1");
    expect(output).not.toContain("No matching lines found");
  });

  it("queries compact JSON through a structured pretty-printed view", () => {
    const compact = JSON.stringify({
      results: [
        { id: 1, message: "routine first record" },
        { id: 2, message: "数据库连接失败" },
        { id: 3, message: "routine last record" },
      ],
    });

    const output = retrieveEntry(entry(compact, "json"), {
      mode: "query",
      query: "数据库",
      contextLines: 0,
      maxChars: 2000,
    });

    expect(output).toContain('"message": "数据库连接失败"');
    expect(output).not.toContain("routine first record");
    expect(output).not.toContain("routine last record");
  });

  it("uses the structured JSON view for head, range, and tail modes", () => {
    const compact = JSON.stringify({
      results: [
        { id: 1, message: "first record" },
        { id: 2, message: "middle record" },
        { id: 3, message: "last record" },
      ],
    });
    const jsonEntry = entry(compact, "json");

    const head = retrieveEntry(jsonEntry, {
      mode: "head",
      lines: 5,
      maxChars: 2000,
    });
    const range = retrieveEntry(jsonEntry, {
      mode: "range",
      startLine: 7,
      endLine: 10,
      maxChars: 2000,
    });
    const tail = retrieveEntry(jsonEntry, {
      mode: "tail",
      lines: 6,
      maxChars: 2000,
    });

    expect(head).toContain('"message": "first record"');
    expect(head).not.toContain("last record");
    expect(range).toContain('"message": "middle record"');
    expect(range).not.toContain("first record");
    expect(range).not.toContain("last record");
    expect(tail).toContain('"message": "last record"');
    expect(tail).not.toContain("first record");
  });

  it.each([
    ["query", { mode: "query" as const, query: "absent-value" }],
    ["head", { mode: "head" as const, lines: 40 }],
    ["tail", { mode: "tail" as const, lines: 40 }],
    [
      "range",
      { mode: "range" as const, startLine: 1, endLine: 40 },
    ],
    ["summary", { mode: "summary" as const }],
  ])("applies maxChars to the complete %s response", (_mode, request) => {
    const original = Array.from(
      { length: 100 },
      (_, index) => `line ${index + 1}: ${"x".repeat(40)}`,
    ).join("\n");
    const maxChars = 96;

    const output = retrieveEntry(entry(original), { ...request, maxChars });

    expect(output.length).toBeLessThanOrEqual(maxChars);
    expect(output).toContain("[truncated");
  });
});
