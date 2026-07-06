import { describe, expect, it } from "vitest";

import { createCCRStore, createContentHash } from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";

describe("CCR store", () => {
  it("creates deterministic 24-character hex content hashes", () => {
    expect(createContentHash("hello world")).toMatch(/^[a-f0-9]{24}$/);
    expect(createContentHash("hello world")).toBe(
      createContentHash("hello world"),
    );
    expect(createContentHash("hello world")).not.toBe(
      createContentHash("hello world!"),
    );
  });

  it("stores and retrieves exact original content with retrieval count", async () => {
    const store = new MemoryCCRStore();
    const entry = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "search",
      originalContent: "original output",
      compressedContent: "compressed output",
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

    const got = await store.get(entry.hash);

    expect(got?.originalContent).toBe("original output");
    expect(got?.retrievalCount).toBe(1);
  });

  it("removes expired entries before retrieval and stats", async () => {
    const store = new MemoryCCRStore(() => 1000);
    const entry = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Read",
      strategy: "json",
      originalContent: "x",
      compressedContent: "y",
      originalTokens: 1,
      compressedTokens: 1,
      ttlMs: 1,
    });

    store.setNowForTest(() => 1002);

    expect(await store.get(entry.hash)).toBeNull();
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("aggregates stats for current entries", async () => {
    const store = new MemoryCCRStore();
    await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "log",
      originalContent: "a".repeat(40),
      compressedContent: "b".repeat(8),
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 60_000,
    });
    await store.put({
      sessionID: "s1",
      callID: "c2",
      tool: "Read",
      strategy: "json",
      originalContent: "c".repeat(20),
      compressedContent: "d".repeat(12),
      originalTokens: 5,
      compressedTokens: 3,
      ttlMs: 60_000,
    });

    const stats = await store.stats("s1");

    expect(stats.entryCount).toBe(2);
    expect(stats.totalOriginalTokens).toBe(15);
    expect(stats.totalCompressedTokens).toBe(5);
    expect(stats.totalTokensSaved).toBe(10);
  });

  it("factory creates memory store", async () => {
    const store = await createCCRStore({ kind: "memory", path: ".x" });

    expect(store).toBeInstanceOf(MemoryCCRStore);
  });
});
