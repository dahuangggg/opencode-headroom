import { describe, expect, it } from "vitest";

import { createCCRStore, createContentHash } from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";

describe("CCR store", () => {
  it("creates deterministic 24-character hex content hashes", () => {
    expect(createContentHash("hello world")).toMatch(/^[a-f0-9]{24}$/);
    expect(createContentHash("hello world")).toBe("b94d27b9934d3e08a52e52d7");
    expect(createContentHash("hello world")).toBe(
      createContentHash("hello world"),
    );
    expect(createContentHash("hello world")).not.toBe(
      createContentHash("hello world!"),
    );
    expect(createContentHash("\uD800")).not.toBe(createContentHash("\uFFFD"));
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
    const gotAgain = await store.get(entry.hash);

    expect(got?.originalContent).toBe("original output");
    expect(got?.retrievalCount).toBe(1);
    expect(gotAgain?.retrievalCount).toBe(2);
    expect((await store.stats()).totalRetrievals).toBe(2);
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
    expect(await store.pruneExpired()).toBe(0);
  });

  it("reports prune counts for expired entries", async () => {
    const store = new MemoryCCRStore(() => 1000);
    await store.put({
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

    expect(await store.pruneExpired(1002)).toBe(1);
  });

  it("aggregates stats for current entries by session", async () => {
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
    await store.put({
      sessionID: "s2",
      callID: "c3",
      tool: "Bash",
      strategy: "log",
      originalContent: "e".repeat(80),
      compressedContent: "f".repeat(4),
      originalTokens: 20,
      compressedTokens: 1,
      ttlMs: 60_000,
    });

    const stats = await store.stats("s1");
    const allStats = await store.stats();

    expect(stats.entryCount).toBe(2);
    expect(stats.totalOriginalTokens).toBe(15);
    expect(stats.totalCompressedTokens).toBe(5);
    expect(stats.totalTokensSaved).toBe(10);
    expect(allStats.entryCount).toBe(3);
    expect(allStats.totalTokensSaved).toBe(29);
  });

  it("keeps duplicate content records independent for stats and ttl", async () => {
    let now = 1000;
    const store = new MemoryCCRStore(() => now);
    const first = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "text",
      originalContent: "same output",
      compressedContent: "same",
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 100,
    });
    const second = await store.put({
      sessionID: "s2",
      callID: "c2",
      tool: "Bash",
      strategy: "text",
      originalContent: "same output",
      compressedContent: "same",
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 1,
    });

    expect(second.hash).toBe(first.hash);
    expect((await store.stats("s1")).entryCount).toBe(1);
    expect((await store.stats("s2")).entryCount).toBe(1);

    now = 1002;

    expect((await store.get(first.hash))?.originalContent).toBe("same output");
    expect((await store.stats("s1")).entryCount).toBe(1);
    expect((await store.stats("s2")).entryCount).toBe(0);
  });

  it("resolves hash collisions without losing exact content", async () => {
    const store = new MemoryCCRStore();
    const firstContent = "\uD841\u0080";
    const secondContent = "js-string-utf16le\0A\u0600\0";

    expect(createContentHash(firstContent)).toBe(
      createContentHash(secondContent),
    );

    const first = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "text",
      originalContent: firstContent,
      compressedContent: "first",
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 60_000,
    });
    const second = await store.put({
      sessionID: "s2",
      callID: "c2",
      tool: "Bash",
      strategy: "text",
      originalContent: secondContent,
      compressedContent: "second",
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

    expect(second.hash).not.toBe(first.hash);
    expect((await store.get(first.hash))?.originalContent).toBe(firstContent);
    expect((await store.get(second.hash))?.originalContent).toBe(secondContent);
  });

  it("rejects invalid ttl values", async () => {
    const store = new MemoryCCRStore();

    await expect(
      store.put({
        sessionID: "s1",
        callID: "c1",
        tool: "Read",
        strategy: "json",
        originalContent: "x",
        compressedContent: "y",
        originalTokens: 1,
        compressedTokens: 1,
        ttlMs: Number.NaN,
      }),
    ).rejects.toThrow(/positive finite/);
  });

  it("factory creates memory store", async () => {
    const store = await createCCRStore({ kind: "memory", path: ".x" });

    expect(store).toBeInstanceOf(MemoryCCRStore);
  });
});
