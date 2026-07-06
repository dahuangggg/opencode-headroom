import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCCRStore, createContentHash } from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";

function createTempDBPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "opencode-headroom-store-"));
  return { dir, path: join(dir, "ccr.sqlite") };
}

const hasBun = (() => {
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function runBunSQLiteScenario<T>(body: string): T {
  const { dir, path } = createTempDBPath();
  try {
    const output = execFileSync(
      "bun",
      [
        "--eval",
        `
import { existsSync } from "node:fs";
import { BunSQLiteCCRStore, createBunSQLiteStore } from "./src/store/sqlite-bun.ts";
import { createContentHash } from "./src/store/ccr.ts";

const dbPath = process.env.CCR_DB_PATH;
if (!dbPath) {
  throw new Error("CCR_DB_PATH is required");
}
const { Database } = await import("bun:sqlite");

function putInput(input = {}) {
  return {
    sessionID: "s1",
    callID: "c1",
    tool: "Bash",
    strategy: "text",
    originalContent: "original output",
    compressedContent: "compressed output",
    originalTokens: 4,
    compressedTokens: 2,
    ttlMs: 60_000,
    ...input,
  };
}

const result = await (async () => {
${body}
})();
console.log(JSON.stringify(result));
`,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          CCR_DB_PATH: path,
        },
      },
    );
    return JSON.parse(output) as T;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

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

  it("does not reuse pruned collision hashes for different content", async () => {
    let now = 1000;
    const store = new MemoryCCRStore(() => now);
    const firstContent = "\uD841\u0080";
    const secondContent = "js-string-utf16le\0A\u0600\0";
    const first = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Bash",
      strategy: "text",
      originalContent: firstContent,
      compressedContent: "first",
      originalTokens: 10,
      compressedTokens: 2,
      ttlMs: 1,
    });

    now = 1002;

    expect(await store.pruneExpired()).toBe(1);

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
    expect(await store.get(first.hash)).toBeNull();
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

const describeBunSQLite = hasBun ? describe : describe.skip;

describeBunSQLite("Bun SQLite CCR store", () => {
  it("round-trips exact original content using a temp database", () => {
    const result = runBunSQLiteScenario<{
      dbExists: boolean;
      originalContent: string | null;
      compressedContent: string | null;
      retrievalCount: number | null;
      entryCount: number;
    }>(`
      const store = await createBunSQLiteStore(dbPath);
      const entry = await store.put(
        putInput({
          sessionID: "s1",
          originalContent: "line 1\\nline 2\\0with nul",
          compressedContent: "compressed sqlite",
        }),
      );
      const got = await store.get(entry.hash);

      return {
        dbExists: existsSync(dbPath),
        originalContent: got?.originalContent ?? null,
        compressedContent: got?.compressedContent ?? null,
        retrievalCount: got?.retrievalCount ?? null,
        totalRetrievals: (await store.stats("s1")).totalRetrievals,
        entryCount: (await store.stats("s1")).entryCount,
      };
    `);

    expect(result.dbExists).toBe(true);
    expect(result.originalContent).toBe("line 1\nline 2\0with nul");
    expect(result.compressedContent).toBe("compressed sqlite");
    expect(result.retrievalCount).toBe(1);
    expect(result.totalRetrievals).toBe(1);
    expect(result.entryCount).toBe(1);
  });

  it("keeps duplicate content records independent for stats and ttl", () => {
    const result = runBunSQLiteScenario<{
      sameHash: boolean;
      beforeS1: number;
      beforeS2: number;
      afterContent: string | null;
      afterS1: number;
      afterS2: number;
    }>(`
      let now = 1000;
      const store = new BunSQLiteCCRStore(dbPath, Database, () => now);
      const first = await store.put(
        putInput({
          sessionID: "s1",
          callID: "c1",
          originalContent: "same sqlite output",
          ttlMs: 100,
        }),
      );
      const second = await store.put(
        putInput({
          sessionID: "s2",
          callID: "c2",
          originalContent: "same sqlite output",
          ttlMs: 1,
        }),
      );

      const beforeS1 = (await store.stats("s1")).entryCount;
      const beforeS2 = (await store.stats("s2")).entryCount;
      now = 1002;

      return {
        sameHash: second.hash === first.hash,
        beforeS1,
        beforeS2,
        afterContent: (await store.get(first.hash))?.originalContent ?? null,
        afterS1: (await store.stats("s1")).entryCount,
        afterS2: (await store.stats("s2")).entryCount,
      };
    `);

    expect(result.sameHash).toBe(true);
    expect(result.beforeS1).toBe(1);
    expect(result.beforeS2).toBe(1);
    expect(result.afterContent).toBe("same sqlite output");
    expect(result.afterS1).toBe(1);
    expect(result.afterS2).toBe(0);
  });

  it("resolves hash collisions without losing exact content", () => {
    const result = runBunSQLiteScenario<{
      collides: boolean;
      sameHash: boolean;
      firstContent: string | null;
      secondContent: string | null;
    }>(`
      const store = await createBunSQLiteStore(dbPath);
      const firstContent = "\\uD841\\u0080";
      const secondContent = "js-string-utf16le\\0A\\u0600\\0";
      const first = await store.put(
        putInput({
          sessionID: "s1",
          callID: "c1",
          originalContent: firstContent,
          compressedContent: "first",
        }),
      );
      const second = await store.put(
        putInput({
          sessionID: "s2",
          callID: "c2",
          originalContent: secondContent,
          compressedContent: "second",
        }),
      );

      return {
        collides: createContentHash(firstContent) === createContentHash(secondContent),
        sameHash: second.hash === first.hash,
        firstContent: (await store.get(first.hash))?.originalContent ?? null,
        secondContent: (await store.get(second.hash))?.originalContent ?? null,
      };
    `);

    expect(createContentHash("\uD841\u0080")).toBe(
      createContentHash("js-string-utf16le\0A\u0600\0"),
    );
    expect(result.collides).toBe(true);
    expect(result.sameHash).toBe(false);
    expect(result.firstContent).toBe("\uD841\u0080");
    expect(result.secondContent).toBe("js-string-utf16le\0A\u0600\0");
  });

  it("does not reuse expired collision hashes for different content", () => {
    const result = runBunSQLiteScenario<{
      firstHash: string;
      secondHash: string;
      prePruneCount: number;
      oldLookup: string | null;
      secondLookup: string | null;
      pruneCount: number;
    }>(`
      let now = 1000;
      const store = new BunSQLiteCCRStore(dbPath, Database, () => now);
      const firstContent = "\\uD841\\u0080";
      const secondContent = "js-string-utf16le\\0A\\u0600\\0";
      const first = await store.put(
        putInput({
          originalContent: firstContent,
          compressedContent: "first",
          ttlMs: 1,
        }),
      );
      now = 1002;
      const prePruneCount = await store.pruneExpired();
      const second = await store.put(
        putInput({
          originalContent: secondContent,
          compressedContent: "second",
          ttlMs: 60_000,
        }),
      );

      return {
        firstHash: first.hash,
        secondHash: second.hash,
        prePruneCount,
        oldLookup: (await store.get(first.hash))?.originalContent ?? null,
        secondLookup: (await store.get(second.hash))?.originalContent ?? null,
        pruneCount: await store.pruneExpired(),
      };
    `);

    expect(result.secondHash).not.toBe(result.firstHash);
    expect(result.prePruneCount).toBe(1);
    expect(result.oldLookup).toBeNull();
    expect(result.secondLookup).toBe("js-string-utf16le\0A\u0600\0");
    expect(result.pruneCount).toBe(0);
  });

  it("rejects invalid ttl values", () => {
    const result = runBunSQLiteScenario<{ message: string }>(`
      const store = await createBunSQLiteStore(dbPath);
      let message = "";
      try {
        await store.put(putInput({ ttlMs: Number.NaN }));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return { message };
    `);

    expect(result.message).toMatch(/positive finite/);
  });
});
