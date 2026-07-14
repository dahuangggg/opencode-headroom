import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  createCCRStore,
  createCollisionHash,
  createContentDigest,
  createContentHash,
  type CCRHashProvider,
} from "../src/store/ccr.js";
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
import {
  createCCRStore,
  createCollisionHash,
  createContentDigest,
  createContentHash,
} from "./src/store/ccr.ts";

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
    expect(createContentHash("\uD841\u0080")).not.toBe(
      createContentHash("js-string-utf16le\0A\u0600\0"),
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
    const gotAgain = await store.get(entry.hash);

    expect(got?.originalContent).toBe("original output");
    expect(got?.retrievalCount).toBe(1);
    expect(gotAgain?.retrievalCount).toBe(2);
    expect((await store.stats()).totalRetrievals).toBe(2);
  });

  it("peeks without counting an internal lookup as a model retrieval", async () => {
    const store = new MemoryCCRStore();
    const entry = await store.put({
      sessionID: "s1",
      callID: "c1",
      tool: "Read",
      strategy: "read_lifecycle_stale",
      originalContent: "original output",
      compressedContent: "compressed output",
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

    expect((await store.peek(entry.hash, "s1"))?.originalContent).toBe(
      "original output",
    );
    expect((await store.stats("s1")).totalRetrievals).toBe(0);
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
    const hashing: CCRHashProvider = {
      contentHash: () => "0".repeat(24),
      contentDigest: createContentDigest,
      collisionHash: createCollisionHash,
    };
    const store = new MemoryCCRStore(undefined, {}, undefined, hashing);
    const firstContent = "first forced collision";
    const secondContent = "second forced collision";

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

  it("allocates exact unique keys for a generated forced-collision family", async () => {
    const hashing: CCRHashProvider = {
      contentHash: () => "0".repeat(24),
      contentDigest: createContentDigest,
      collisionHash: createCollisionHash,
    };
    const store = new MemoryCCRStore(undefined, {}, undefined, hashing);
    const hashes = new Set<string>();

    for (let index = 0; index < 32; index += 1) {
      const originalContent = `generated-collision-${index}`;
      const entry = await store.put({
        sessionID: "generated-session",
        callID: `generated-${index}`,
        tool: "Bash",
        strategy: "text",
        originalContent,
        compressedContent: `compressed-${index}`,
        originalTokens: 4,
        compressedTokens: 2,
        ttlMs: 60_000,
      });
      hashes.add(entry.hash);
      expect(
        (await store.get(entry.hash, "generated-session"))?.originalContent,
      ).toBe(originalContent);
    }

    expect(hashes.size).toBe(32);
  });

  it("releases pruned collision history while preserving session scope", async () => {
    let now = 1000;
    const hashing: CCRHashProvider = {
      contentHash: () => "0".repeat(24),
      contentDigest: createContentDigest,
      collisionHash: createCollisionHash,
    };
    const store = new MemoryCCRStore(() => now, {}, undefined, hashing);
    const firstContent = "expired forced collision";
    const secondContent = "replacement forced collision";
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

    expect(second.hash).toBe(first.hash);
    expect(await store.get(first.hash, "s1")).toBeNull();
    expect((await store.get(second.hash, "s2"))?.originalContent).toBe(
      secondContent,
    );
  });

  it("bounds live hash history and clears it when get prunes expiry", async () => {
    let now = 1000;
    const store = new MemoryCCRStore(() => now, { maxEntries: 2 });
    for (let index = 0; index < 10; index += 1) {
      await store.put({
        sessionID: "s1",
        callID: `c${index}`,
        tool: "Bash",
        strategy: "text",
        originalContent: `bounded-${index}`,
        compressedContent: `compressed-${index}`,
        originalTokens: 4,
        compressedTokens: 2,
        ttlMs: 60_000,
      });
    }
    const history = (
      store as unknown as { hashHistory: Map<string, Set<string>> }
    ).hashHistory;
    expect((await store.stats()).entryCount).toBe(2);
    expect(history.size).toBe(2);
    expect([...history.values()].reduce((sum, values) => sum + values.size, 0)).toBe(
      2,
    );

    const expiring = new MemoryCCRStore(() => now);
    const entry = await expiring.put({
      sessionID: "s1",
      tool: "Bash",
      strategy: "text",
      originalContent: "expires-on-get",
      compressedContent: "compressed",
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 1,
    });
    now = 1002;
    expect(await expiring.get(entry.hash, "s1")).toBeNull();
    expect(
      (expiring as unknown as { hashHistory: Map<string, Set<string>> })
        .hashHistory.size,
    ).toBe(0);
  });

  it("does not evict a live entry when final marker rendering fails", async () => {
    const store = new MemoryCCRStore(undefined, { maxEntries: 1 });
    const retained = await store.put({
      sessionID: "s1",
      callID: "retained",
      tool: "Bash",
      strategy: "text",
      originalContent: "retained original",
      compressedContent: "retained compressed",
      originalTokens: 4,
      compressedTokens: 2,
      ttlMs: 60_000,
    });

    await expect(
      store.put({
        sessionID: "s1",
        callID: "failing",
        tool: "Bash",
        strategy: "text",
        originalContent: "failing original",
        compressedContent: "preliminary compressed",
        originalTokens: 4,
        compressedTokens: 2,
        ttlMs: 60_000,
        contentForHash: () => {
          throw new Error("marker rendering failed");
        },
      }),
    ).rejects.toThrow(/marker rendering failed/);

    expect((await store.get(retained.hash, "s1"))?.originalContent).toBe(
      "retained original",
    );
    expect((await store.stats()).entryCount).toBe(1);
    const history = (
      store as unknown as { hashHistory: Map<string, Set<string>> }
    ).hashHistory;
    expect([...history.keys()]).toEqual([retained.hash]);
    expect([...history.get(retained.hash)!]).toEqual([
      createContentDigest("retained original"),
    ]);
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
    expect(store.diagnostics).toEqual({
      requested: "memory",
      active: "memory",
    });
  });
});

const describeBunSQLite = hasBun ? describe : describe.skip;

describeBunSQLite("Bun SQLite CCR store", () => {
  it("does not silently fall back when auto SQLite initialization fails", () => {
    const result = runBunSQLiteScenario<{
      active: string | null;
      message: string;
    }>(`
      let active = null;
      let message = "";
      try {
        const store = await createCCRStore({
          kind: "auto",
          path: "/dev/null/opencode-headroom.sqlite",
        });
        active = store.diagnostics.active;
        await store.close();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      return { active, message };
    `);

    expect(result.active).toBeNull();
    expect(result.message).toMatch(/ENOTDIR|not a directory|mkdir/i);
  });

  it.skipIf(
    process.platform === "win32" || (process.getuid?.() ?? 1) === 0,
  )("surfaces an explicit SQLite permission failure", () => {
    const { dir } = createTempDBPath();
    const blockedDirectory = join(dir, "blocked");
    const path = join(blockedDirectory, "ccr.sqlite");
    mkdirSync(blockedDirectory);
    chmodSync(blockedDirectory, 0o000);

    try {
      const output = execFileSync(
        "bun",
        [
          "--eval",
          `
import { createBunSQLiteStore } from "./src/store/sqlite-bun.ts";

let active = null;
let message = "";
try {
  const store = await createBunSQLiteStore(process.env.CCR_DB_PATH);
  active = store.diagnostics.active;
  await store.close();
} catch (error) {
  message = error instanceof Error ? error.message : String(error);
}
console.log(JSON.stringify({ active, message }));
`,
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: { ...process.env, CCR_DB_PATH: path },
        },
      );
      const result = JSON.parse(output) as {
        active: string | null;
        message: string;
      };

      expect(result.active).toBeNull();
      expect(result.message).toMatch(/permission|readonly|unable to open/i);
    } finally {
      chmodSync(blockedDirectory, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("peeks SQLite entries without incrementing retrievals", () => {
    const result = runBunSQLiteScenario<{
      originalContent: string | null;
      totalRetrievals: number;
    }>(`
      const store = await createBunSQLiteStore(dbPath);
      const entry = await store.put(
        putInput({
          tool: "Read",
          strategy: "read_lifecycle_stale",
          originalContent: "sqlite lifecycle original",
        }),
      );
      const peeked = await store.peek(entry.hash, "s1");
      return {
        originalContent: peeked?.originalContent ?? null,
        totalRetrievals: (await store.stats("s1")).totalRetrievals,
      };
    `);

    expect(result).toEqual({
      originalContent: "sqlite lifecycle original",
      totalRetrievals: 0,
    });
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
      const hashing = {
        contentHash: () => "0".repeat(24),
        contentDigest: createContentDigest,
        collisionHash: createCollisionHash,
      };
      const store = new BunSQLiteCCRStore(
        dbPath,
        Database,
        undefined,
        {},
        undefined,
        hashing,
      );
      const firstContent = "first forced collision";
      const secondContent = "second forced collision";
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
        collides: hashing.contentHash(firstContent) === hashing.contentHash(secondContent),
        sameHash: second.hash === first.hash,
        firstContent: (await store.get(first.hash))?.originalContent ?? null,
        secondContent: (await store.get(second.hash))?.originalContent ?? null,
      };
    `);

    expect(result.collides).toBe(true);
    expect(result.sameHash).toBe(false);
    expect(result.firstContent).toBe("first forced collision");
    expect(result.secondContent).toBe("second forced collision");
  });

  it("allocates exact unique SQLite keys for generated forced collisions", () => {
    const result = runBunSQLiteScenario<{
      uniqueHashes: number;
      exact: boolean;
    }>(`
      const hashing = {
        contentHash: () => "0".repeat(24),
        contentDigest: createContentDigest,
        collisionHash: createCollisionHash,
      };
      const store = new BunSQLiteCCRStore(
        dbPath,
        Database,
        undefined,
        {},
        undefined,
        hashing,
      );
      const hashes = new Set();
      let exact = true;
      for (let index = 0; index < 32; index += 1) {
        const originalContent = "generated-collision-" + index;
        const entry = await store.put(putInput({
          sessionID: "generated-session",
          callID: "generated-" + index,
          originalContent,
        }));
        hashes.add(entry.hash);
        exact = exact &&
          (await store.get(entry.hash, "generated-session"))?.originalContent ===
            originalContent;
      }
      return { uniqueHashes: hashes.size, exact };
    `);

    expect(result.uniqueHashes).toBe(32);
    expect(result.exact).toBe(true);
  });

  it("releases expired collision history while preserving session scope", () => {
    const result = runBunSQLiteScenario<{
      firstHash: string;
      secondHash: string;
      prePruneCount: number;
      oldLookup: string | null;
      secondLookup: string | null;
      pruneCount: number;
      historyCount: number;
    }>(`
      let now = 1000;
      const hashing = {
        contentHash: () => "0".repeat(24),
        contentDigest: createContentDigest,
        collisionHash: createCollisionHash,
      };
      const store = new BunSQLiteCCRStore(
        dbPath,
        Database,
        () => now,
        {},
        undefined,
        hashing,
      );
      const firstContent = "expired forced collision";
      const secondContent = "replacement forced collision";
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
          sessionID: "s2",
          originalContent: secondContent,
          compressedContent: "second",
          ttlMs: 60_000,
        }),
      );

      return {
        firstHash: first.hash,
        secondHash: second.hash,
        prePruneCount,
        oldLookup: (await store.get(first.hash, "s1"))?.originalContent ?? null,
        secondLookup: (await store.get(second.hash, "s2"))?.originalContent ?? null,
        pruneCount: await store.pruneExpired(),
        historyCount: store.db
          .query("SELECT COUNT(*) AS count FROM ccr_hash_history")
          .get().count,
      };
    `);

    expect(result.secondHash).toBe(result.firstHash);
    expect(result.prePruneCount).toBe(1);
    expect(result.oldLookup).toBeNull();
    expect(result.secondLookup).toBe("replacement forced collision");
    expect(result.pruneCount).toBe(0);
    expect(result.historyCount).toBe(1);
  });

  it("bounds SQLite hash history to active entries", () => {
    const result = runBunSQLiteScenario<{
      entryCount: number;
      historyCount: number;
    }>(`
      const store = new BunSQLiteCCRStore(
        dbPath,
        Database,
        undefined,
        { maxEntries: 2 },
      );
      for (let index = 0; index < 10; index += 1) {
        await store.put(putInput({
          callID: "c" + index,
          originalContent: "bounded-" + index,
        }));
      }
      return {
        entryCount: (await store.stats()).entryCount,
        historyCount: store.db
          .query("SELECT COUNT(*) AS count FROM ccr_hash_history")
          .get().count,
      };
    `);

    expect(result.entryCount).toBe(2);
    expect(result.historyCount).toBe(2);
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

  it("persists bounded retrieval defaults across SQLite restarts", () => {
    const result = runBunSQLiteScenario<{
      mode: string | null;
      maxChars: number | null;
    }>(`
      const first = await createBunSQLiteStore(dbPath);
      const entry = await first.put(
        putInput({
          originalContent: "persisted retrieval policy",
          retrieveDefaults: { mode: "tail", maxChars: 321 },
        }),
      );
      await first.close();

      const reopened = await createBunSQLiteStore(dbPath);
      const restored = await reopened.get(entry.hash, "s1");
      await reopened.close();
      return {
        mode: restored?.retrieveDefaults?.mode ?? null,
        maxChars: restored?.retrieveDefaults?.maxChars ?? null,
      };
    `);

    expect(result).toEqual({ mode: "tail", maxChars: 321 });
  });

  it("migrates active schema-v1 rows to bounded retrieval defaults", () => {
    const result = runBunSQLiteScenario<{
      original: string | null;
      mode: string | null;
      maxChars: number | null;
      userVersion: number;
    }>(`
      const original = "legacy active content";
      const compressed = "legacy compressed";
      const hash = createContentHash(original);
      const seed = new Database(dbPath);
      seed.exec([
        "CREATE TABLE ccr_entries (",
        "id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "hash TEXT NOT NULL, session_id TEXT NOT NULL, call_id TEXT, tool TEXT,",
        "strategy TEXT NOT NULL, original_content BLOB NOT NULL,",
        "compressed_content BLOB NOT NULL, original_tokens INTEGER NOT NULL,",
        "compressed_tokens INTEGER NOT NULL, original_chars INTEGER NOT NULL,",
        "compressed_chars INTEGER NOT NULL, created_at INTEGER NOT NULL,",
        "expires_at INTEGER NOT NULL, retrieval_count INTEGER NOT NULL DEFAULT 0",
        ");",
      ].join(" "));
      seed.query([
        "INSERT INTO ccr_entries",
        "(hash, session_id, call_id, tool, strategy, original_content,",
        "compressed_content, original_tokens, compressed_tokens,",
        "original_chars, compressed_chars, created_at, expires_at, retrieval_count)",
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ].join(" ")).run(
          hash,
          "s1",
          "legacy-call",
          "Bash",
          "text",
          Buffer.from(original, "utf16le"),
          Buffer.from(compressed, "utf16le"),
          10,
          3,
          original.length,
          compressed.length,
          Date.now(),
          Date.now() + 60_000,
          0,
        );
      seed.exec("PRAGMA user_version = 1");
      seed.close();

      const migrated = await createBunSQLiteStore(dbPath);
      const restored = await migrated.get(hash, "s1");
      await migrated.close();
      const inspector = new Database(dbPath, { readonly: true });
      const userVersion = inspector.query("PRAGMA user_version").get().user_version;
      inspector.close();
      return {
        original: restored?.originalContent ?? null,
        mode: restored?.retrieveDefaults?.mode ?? null,
        maxChars: restored?.retrieveDefaults?.maxChars ?? null,
        userVersion,
      };
    `);

    expect(result).toEqual({
      original: "legacy active content",
      mode: "summary",
      maxChars: 12_000,
      userVersion: 2,
    });
  });
});
