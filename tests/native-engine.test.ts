import { describe, expect, it } from "vitest";

import { compressionProfileForStrength } from "../src/compressors/profile.js";
import {
  buildCompressionQuery,
  NativeHeadroomCompatibleEngine,
} from "../src/engine/native.js";
import {
  CompressionDecisionCache,
  createCompressionDecisionKey,
  StrategyCircuitBreaker,
} from "../src/engine/resilience.js";
import { compressByContentType } from "../src/engine/router.js";
import { SessionRepetitionStore } from "../src/session/repetition.js";
import {
  createCollisionHash,
  createContentDigest,
  createContentHash,
  type CCRHashProvider,
} from "../src/store/ccr.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { estimateTokens } from "../src/token.js";
import { largeJsonArrayFixture, searchFixture } from "./fixtures.js";

function decisionCache() {
  return new CompressionDecisionCache({
    maxEntries: 32,
    maxResultChars: 1_000_000,
    maxSingleResultChars: 500_000,
  });
}

function countingCompressor(counter: { calls: number }) {
  return (...args: Parameters<typeof compressByContentType>) => {
    counter.calls += 1;
    return compressByContentType(...args);
  };
}

function compressionInput(
  output: string,
  sessionID: string,
  callID: string,
  overrides: Partial<{
    args: unknown;
    intent: string;
    strength: "conservative" | "balanced" | "aggressive";
  }> = {},
) {
  return {
    tool: "Bash",
    sessionID,
    callID,
    args: overrides.args ?? { command: "rg auth" },
    ...(overrides.intent === undefined ? {} : { intent: overrides.intent }),
    output,
    ttlMs: 60_000,
    ...(overrides.strength === undefined
      ? {}
      : { strength: overrides.strength }),
  };
}

describe("native engine", () => {
  it("reuses a positive decision across sessions while storing exact CCR originals", async () => {
    const store = new MemoryCCRStore();
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      store,
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const original = searchFixture();

    const first = await engine.compress(
      compressionInput(original, "positive-1", "call-1"),
    );
    const second = await engine.compress(
      compressionInput(original, "positive-2", "call-2"),
    );

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(second.output).toBe(first.output);
    expect(counter.calls).toBe(1);
    expect(cache.stats.resultEntryCount).toBe(1);
    expect(
      await engine.retrieve(first.hash!, { mode: "full" }, "positive-1"),
    ).toEqual({ found: true, output: original });
    expect(
      await engine.retrieve(second.hash!, { mode: "full" }, "positive-2"),
    ).toEqual({ found: true, output: original });
  });

  it("reuses stable negative decisions without retaining or returning cached raw output", async () => {
    const store = new MemoryCCRStore();
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      store,
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const firstInput = compressionInput("small", "negative-1", "call-1", {
      args: {},
    });
    const secondInput = {
      ...compressionInput("small", "negative-2", "call-2", { args: {} }),
      ttlMs: 5,
      retrieveDefaults: { mode: "full" as const },
    };

    const first = await engine.compress(firstInput);
    const second = await engine.compress(secondInput);
    const key = createCompressionDecisionKey({
      content: firstInput.output,
      query: buildCompressionQuery(firstInput.args, firstInput.intent),
      profile: compressionProfileForStrength("balanced"),
    });
    const cached = cache.get(key);

    expect(first.changed).toBe(false);
    expect(second).toMatchObject({ changed: false, output: secondInput.output });
    expect(counter.calls).toBe(1);
    expect(cached?.kind).toBe("skip");
    expect(Object.keys(cached ?? {})).not.toContain("output");
    expect(Object.keys(cached ?? {})).not.toContain("raw");
    expect((await store.stats()).entryCount).toBe(0);
  });

  it("isolates decisions by query, strength, known tokens, and lossless mode", async () => {
    const cache = decisionCache();
    const counter = { calls: 0 };
    const original = searchFixture();
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );

    await engine.compress(
      compressionInput(original, "isolation-1", "call-1", {
        intent: "auth failures",
      }),
    );
    await engine.compress(
      compressionInput(original, "isolation-2", "call-2", {
        intent: "database failures",
      }),
    );
    await engine.compress(
      compressionInput(original, "isolation-3", "call-3", {
        intent: "database failures",
        strength: "aggressive",
      }),
    );
    await engine.compressWithKnownTokens(
      compressionInput(original, "isolation-4", "call-4", {
        intent: "database failures",
        strength: "aggressive",
      }),
      estimateTokens(original) + 1,
    );

    const losslessEngine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      { losslessThenLossy: true },
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    await losslessEngine.compressWithKnownTokens(
      compressionInput(original, "isolation-5", "call-5", {
        intent: "database failures",
        strength: "aggressive",
      }),
      estimateTokens(original) + 1,
    );

    expect(counter.calls).toBe(5);
    expect(cache.stats.entryCount).toBe(5);
  });

  it("checks same-session repetition before the global decision cache", async () => {
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const original = searchFixture();

    await engine.compress(compressionInput(original, "repeat", "call-1"));
    const repeated = await engine.compress(
      compressionInput(original, "repeat", "call-2"),
    );

    expect(repeated.strategy).toBe("repetition");
    expect(counter.calls).toBe(1);
  });

  it("rerenders a cached result only when the store commits a collision hash", async () => {
    const original = largeJsonArrayFixture();
    const collider = `${original}\n `;
    const forcedHash = createContentHash(original);
    const hashing: CCRHashProvider = {
      contentHash: (content) =>
        content === original || content === collider
          ? forcedHash
          : createContentHash(content),
      contentDigest: createContentDigest,
      collisionHash: createCollisionHash,
    };
    const store = new MemoryCCRStore(undefined, {}, undefined, hashing);
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      store,
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const input = compressionInput(original, "collision-1", "call-1", {
      args: { command: "cat data.json" },
    });

    const first = await engine.compress(input);
    await store.deleteSession("collision-1");
    await store.put({
      sessionID: "collider",
      strategy: "fixture",
      originalContent: collider,
      compressedContent: "collider",
      originalTokens: 10,
      compressedTokens: 1,
      ttlMs: 60_000,
    });
    engine.deleteSessionState("collision-1");
    const second = await engine.compress({
      ...input,
      sessionID: "collision-2",
      callID: "call-2",
    });
    const third = await engine.compress({
      ...input,
      sessionID: "collision-3",
      callID: "call-3",
    });
    const key = createCompressionDecisionKey({
      content: original,
      query: buildCompressionQuery(input.args, input.intent),
      profile: compressionProfileForStrength("balanced"),
    });
    const cached = cache.get(key);

    expect(first.hash).toBe(forcedHash);
    expect(second.hash).not.toBe(first.hash);
    expect(second.output).toContain(second.hash!);
    expect(second.output).not.toContain(`[Retrieve more: hash=${first.hash}]`);
    expect(third.output).toBe(second.output);
    expect(counter.calls).toBe(2);
    expect(cached).toMatchObject({
      kind: "result",
      renderedHash: second.hash,
      output: second.output,
    });
    expect(
      await engine.retrieve(second.hash!, { mode: "full" }, "collision-2"),
    ).toEqual({ found: true, output: original });
    expect(
      await engine.retrieve(third.hash!, { mode: "full" }, "collision-3"),
    ).toEqual({ found: true, output: original });
  });

  it("keeps cache across session deletion but clears it with global session state", async () => {
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const original = searchFixture();

    await engine.compress(compressionInput(original, "clear-1", "call-1"));
    engine.deleteSessionState("clear-1");
    await engine.compress(compressionInput(original, "clear-2", "call-2"));
    expect(counter.calls).toBe(1);

    engine.clearSessionState();
    expect(cache.stats.entryCount).toBe(0);
    await engine.compress(compressionInput(original, "clear-3", "call-3"));
    expect(counter.calls).toBe(2);
  });

  it("does not cache bypassed, failed, or circuit-open compression attempts", async () => {
    const cache = decisionCache();
    const counter = { calls: 0 };
    const compressor: typeof compressByContentType = (input) => {
      counter.calls += 1;
      if (input.content === "throw") {
        throw new Error("compressor failed");
      }
      return {
        changed: false,
        output: input.content,
        strategy: "text",
        reason: "strategy_circuit_open",
      };
    };
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor },
    );

    await engine.compress(compressionInput("   ", "transient-1", "call-1"));
    await engine.compress(
      compressionInput(
        "marked\n[Retrieve more: hash=1234567890abcdef12345678]",
        "transient-2",
        "call-2",
      ),
    );
    await engine.compress(compressionInput("open", "transient-3", "call-3"));
    await engine.compress(compressionInput("open", "transient-4", "call-4"));
    await expect(
      engine.compress(compressionInput("throw", "transient-5", "call-5")),
    ).rejects.toThrow("compressor failed");

    expect(counter.calls).toBe(3);
    expect(cache.stats.entryCount).toBe(0);
  });

  it("passes the circuit breaker into routing and clears it on disposal state reset", async () => {
    const cache = decisionCache();
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("search");
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, circuitBreaker: breaker },
    );
    const original = searchFixture();

    const bypassed = await engine.compress(
      compressionInput(original, "breaker-1", "call-1"),
    );
    expect(bypassed).toMatchObject({
      changed: false,
      output: original,
      strategy: "search",
      reason: "strategy_circuit_open",
    });
    expect(cache.stats.entryCount).toBe(0);

    engine.clearSessionState();
    const recovered = await engine.compress(
      compressionInput(original, "breaker-2", "call-2"),
    );
    expect(recovered.changed).toBe(true);
  });

  it("does not cache a partial mixed result while one section circuit is open", async () => {
    let now = 5_000;
    const cache = decisionCache();
    const breaker = new StrategyCircuitBreaker({
      failureThreshold: 1,
      clock: () => now,
    });
    breaker.recordFailure("json");
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      new MemoryCCRStore(),
      {},
      new SessionRepetitionStore(),
      {
        decisionCache: cache,
        circuitBreaker: breaker,
        compressor: countingCompressor(counter),
      },
    );
    const code = Array.from(
      { length: 20 },
      (_, index) =>
        [
          `export function value${index}(input: number): number {`,
          `  const stage0 = input + ${index};`,
          "  const stage1 = stage0 + 1;",
          "  const stage2 = stage1 + 2;",
          "  const stage3 = stage2 + 3;",
          "  const stage4 = stage3 + 4;",
          "  const stage5 = stage4 + 5;",
          "  return stage5;",
          "}",
        ].join("\n"),
    ).join("\n\n");
    const json = JSON.stringify(
      Array.from({ length: 40 }, (_, index) => ({
        id: index,
        status: "ok",
        message: `event ${index}`,
      })),
    );
    const mixed = `<stdout>\n${code}\n</stdout>\n<stderr>\n${json}\n</stderr>`;

    const first = await engine.compress(
      compressionInput(mixed, "mixed-open-1", "call-1"),
    );
    const second = await engine.compress(
      compressionInput(mixed, "mixed-open-2", "call-2"),
    );
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(true);
    expect(counter.calls).toBe(2);
    expect(cache.stats.entryCount).toBe(0);

    now += 60_000;
    const recovered = await engine.compress(
      compressionInput(mixed, "mixed-recovered", "call-3"),
    );
    expect(recovered.changed).toBe(true);
    expect(recovered.output.length).toBeLessThan(first.output.length);
    expect(counter.calls).toBe(3);
    expect(cache.stats.resultEntryCount).toBe(1);
  });

  it("writes a positive decision only after CCR storage succeeds", async () => {
    const store = new MemoryCCRStore();
    const originalPut = store.put.bind(store);
    store.put = async () => {
      throw new Error("store failed");
    };
    const cache = decisionCache();
    const counter = { calls: 0 };
    const engine = new NativeHeadroomCompatibleEngine(
      store,
      {},
      new SessionRepetitionStore(),
      { decisionCache: cache, compressor: countingCompressor(counter) },
    );
    const original = searchFixture();

    await expect(
      engine.compress(compressionInput(original, "store-1", "call-1")),
    ).rejects.toThrow("store failed");
    expect(cache.stats.entryCount).toBe(0);

    store.put = originalPut;
    const recovered = await engine.compress(
      compressionInput(original, "store-2", "call-2"),
    );
    expect(recovered.changed).toBe(true);
    expect(counter.calls).toBe(2);
    expect(cache.stats.resultEntryCount).toBe(1);
  });

  it("bounds the default engine decision cache to 512 entries", async () => {
    const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());

    for (let index = 0; index < 513; index += 1) {
      await engine.compress(
        compressionInput(`small-${index}`, `bounded-${index}`, `call-${index}`, {
          args: {},
        }),
      );
    }

    expect(engine.decisionCacheStats).toEqual({
      entryCount: 512,
      resultEntryCount: 0,
      skipEntryCount: 512,
      resultChars: 0,
    });
  });

  it("stores AST-compressed Python and retrieves the exact original", async () => {
    const store = new MemoryCCRStore();
    const engine = new NativeHeadroomCompatibleEngine(store);
    const original = [
      "from typing import Final",
      "",
      ...Array.from({ length: 16 }, (_, index) => [
        `def routine_${index}(value: int) -> int:`,
        '    """Compute a routine value."""',
        `    stage_0 = value + ${index}`,
        "    stage_1 = stage_0 + 1",
        "    stage_2 = stage_1 + 2",
        "    stage_3 = stage_2 + 3",
        "    stage_4 = stage_3 + 4",
        "    stage_5 = stage_4 + 5",
        "    stage_6 = stage_5 + 6",
        "    return stage_6",
        "",
      ]).flat(),
      "VERSION: Final = 1",
    ].join("\n");

    const result = await engine.compress({
      tool: "Bash",
      sessionID: "python-session",
      callID: "python-call",
      args: { command: "python inspect.py" },
      output: original,
      ttlMs: 60_000,
    });

    expect(result.changed).toBe(true);
    expect(result.strategy).toBe("code");
    expect(result.output).toContain("# [Retrieve more: hash=");
    expect(result.output).toContain("pass  # … 9 lines omitted …");
    expect(await engine.retrieve(result.hash!, { mode: "full" })).toEqual({
      found: true,
      output: original,
    });
  });

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
