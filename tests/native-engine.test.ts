import { describe, expect, it } from "vitest";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { estimateTokens } from "../src/token.js";
import { largeJsonArrayFixture, searchFixture } from "./fixtures.js";

describe("native engine", () => {
  it("compresses and stores original output", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = largeJsonArrayFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "cat data.json" },
      output: original,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.hash).toMatch(/^[a-f0-9]{24}$/);
    expect(result.output).toContain(result.hash);
    expect(await engine.retrieve(result.hash!, { mode: "full" })).toEqual({
      found: true,
      output: original,
    });
  });

  it("uses a bounded summary for bare retrieval and requires explicit full", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = searchFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: original,
      ttlMs: 60_000,
    });

    const bounded = await engine.retrieve(result.hash!);
    const full = await engine.retrieve(result.hash!, { mode: "full" });

    expect(bounded.output).toContain("mode: summary");
    expect(bounded.output).not.toBe(original);
    expect(bounded.output.length).toBeLessThanOrEqual(12_000);
    expect(full.output).toBe(original);
  });

  it("does not store when compression has no savings", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: {},
      output: "small",
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(false);
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("does not double-compress marked output", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const output = "already compressed\n[Retrieve more: hash=1234567890abcdef12345678]";
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: {},
      output,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(false);
    expect(result.output).toBe(output);
    expect(result.reason).toBe("empty_or_marked");
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("reports stats", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: searchFixture(),
      ttlMs: 60_000,
    });

    const stats = await engine.stats("s1");
    expect(stats.output).toContain("entries: 1");
    expect(stats.output).toContain("tokens saved");
  });

  it("retrieves query-matching snippets instead of full original content", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = searchFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: original,
      ttlMs: 60_000,
    });

    const retrieved = await engine.retrieve(result.hash!, {
      mode: "query",
      query: "ERROR token rejected",
      contextLines: 1,
      maxMatches: 2,
    });

    expect(retrieved.found).toBe(true);
    expect(retrieved.output).toContain("mode: query");
    expect(retrieved.output).toContain("ERROR auth token rejected");
    expect(retrieved.output).not.toBe(original);
    expect(estimateTokens(retrieved.output)).toBeLessThan(estimateTokens(original));
  });

  it("treats maxChars as a hard limit including truncation metadata", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: searchFixture(),
      ttlMs: 60_000,
    });

    const retrieved = await engine.retrieve(result.hash!, {
      mode: "query",
      query: "auth",
      maxMatches: 20,
      maxChars: 160,
    });

    expect(retrieved.output.length).toBeLessThanOrEqual(160);
    expect(retrieved.output).toContain("[truncated");
  });

  it("retrieves explicit line ranges", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = searchFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: original,
      ttlMs: 60_000,
    });

    const retrieved = await engine.retrieve(result.hash!, {
      mode: "range",
      startLine: 2,
      endLine: 4,
    });

    expect(retrieved.output).toContain("mode: range");
    expect(retrieved.output).toContain("2: src/auth.ts:2:auth event 2");
    expect(retrieved.output).toContain("4: src/auth.ts:4:auth event 4");
    expect(retrieved.output).not.toContain("5: src/auth.ts:5:auth event 5");
  });

  it("retrieves compact summaries for inspection", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = searchFixture();
    const result = await engine.compress({
      tool: "Bash",
      sessionID: "s1",
      callID: "c1",
      args: { command: "rg auth" },
      output: original,
      ttlMs: 60_000,
    });

    const retrieved = await engine.retrieve(result.hash!, {
      mode: "summary",
    });

    expect(retrieved.output).toContain("mode: summary");
    expect(retrieved.output).toContain(`hash: ${result.hash}`);
    expect(retrieved.output).toContain("strategy: search");
    expect(retrieved.output).not.toBe(original);
  });
});
