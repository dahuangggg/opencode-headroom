import { describe, expect, it } from "vitest";

import {
  CompressionDecisionCache,
  createCompressionDecisionKey,
  StrategyCircuitBreaker,
} from "../src/engine/resilience.js";
import { compressionProfileForStrength } from "../src/compressors/profile.js";

function result(output: string, strategy = "code") {
  return {
    output,
    renderedHash: "111111111111111111111111",
    strategy,
    originalTokens: 100,
    compressedTokens: 20,
  };
}

describe("CompressionDecisionCache", () => {
  it("builds a versioned key from every compression-affecting input", () => {
    const balanced = compressionProfileForStrength("balanced");
    const base = {
      content: "full original content",
      query: "find auth failures",
      profile: balanced,
    };
    const key = createCompressionDecisionKey(base);

    expect(key).toMatch(/^compression-decision:v1:/);
    expect(
      createCompressionDecisionKey({ ...base, strength: "balanced" }),
    ).toBe(key);
    expect(
      createCompressionDecisionKey({ ...base, content: `${base.content}!` }),
    ).not.toBe(key);
    expect(
      createCompressionDecisionKey({ ...base, query: `${base.query}!` }),
    ).not.toBe(key);
    expect(
      createCompressionDecisionKey({ ...base, strength: "aggressive" }),
    ).not.toBe(key);
    expect(
      createCompressionDecisionKey({
        ...base,
        profile: {
          ...balanced,
          json: { ...balanced.json, maxItems: balanced.json.maxItems + 1 },
        },
      }),
    ).not.toBe(key);
    expect(
      createCompressionDecisionKey({ ...base, losslessThenLossy: true }),
    ).not.toBe(key);
    expect(
      createCompressionDecisionKey({ ...base, knownOriginalTokens: 42 }),
    ).not.toBe(key);
  });

  it("uses a 30 minute default TTL without turning reads into sliding expiry", () => {
    let now = 1_000;
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 100,
      clock: () => now,
    });

    cache.putResult("digest", result("compressed"));
    now += 30 * 60 * 1_000 - 1;
    expect(cache.get("digest")?.kind).toBe("result");

    now += 1;
    expect(cache.get("digest")).toBeUndefined();
    expect(cache.stats).toEqual({
      entryCount: 0,
      resultEntryCount: 0,
      skipEntryCount: 0,
      resultChars: 0,
    });
  });

  it("refreshes global LRU order on get across result and skip entries", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });

    cache.putResult("result-a", result("aaaa"));
    cache.putSkip("skip-b", {
      strategy: "table",
      reason: "too_few_lines",
      originalTokens: 12,
    });
    expect(cache.get("result-a")?.kind).toBe("result");
    cache.putSkip("skip-c", {
      strategy: "log",
      reason: "no_savings",
      originalTokens: 18,
    });

    expect(cache.get("skip-b")).toBeUndefined();
    expect(cache.get("result-a")?.kind).toBe("result");
    expect(cache.get("skip-c")?.kind).toBe("skip");
  });

  it("enforces maxEntries as a hard limit", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 1,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });

    cache.putSkip("first", {
      strategy: "json",
      reason: "not_large_array",
      originalTokens: 4,
    });
    cache.putResult("second", result("kept"));

    expect(cache.get("first")).toBeUndefined();
    expect(cache.get("second")?.kind).toBe("result");
    expect(cache.stats.entryCount).toBe(1);
  });

  it("evicts least-recently-used entries until total result chars fit", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 4,
      maxResultChars: 7,
      maxSingleResultChars: 7,
    });

    cache.putResult("old", result("1234"));
    cache.putSkip("skip", {
      strategy: "search",
      reason: "too_few_matches",
      originalTokens: 2,
    });
    cache.putResult("new", result("5678"));

    expect(cache.get("old")).toBeUndefined();
    expect(cache.get("skip")?.kind).toBe("skip");
    expect(cache.get("new")?.kind).toBe("result");
    expect(cache.stats.resultChars).toBe(4);
  });

  it("does not retain a result larger than the single-result limit", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 10,
      maxSingleResultChars: 5,
    });

    expect(cache.putResult("large", result("123456"))).toBe(false);
    expect(cache.get("large")).toBeUndefined();
    expect(cache.stats).toEqual({
      entryCount: 0,
      resultEntryCount: 0,
      skipEntryCount: 0,
      resultChars: 0,
    });
  });

  it("stores skip metadata without an output or raw-content surface", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });
    const untrusted = {
      strategy: "log",
      reason: "no_savings",
      originalTokens: 30,
      output: "must not be retained",
      raw: "must not be retained either",
    };

    cache.putSkip("digest", untrusted);

    expect(cache.get("digest")).toEqual({
      kind: "skip",
      strategy: "log",
      reason: "no_savings",
      originalTokens: 30,
    });
    expect(Object.keys(cache.get("digest") ?? {})).not.toContain("output");
    expect(Object.keys(cache.get("digest") ?? {})).not.toContain("raw");
  });

  it("bounds metadata and never retains result debug payloads", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 4,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });
    const withDebug = {
      ...result("compressed"),
      debug: { raw: "must not be retained" },
    };

    expect(cache.putResult("safe", withDebug)).toBe(true);
    expect(Object.keys(cache.get("safe") ?? {})).not.toContain("debug");
    expect(
      cache.putResult("long-strategy", {
        ...result("compressed"),
        strategy: "s".repeat(65),
      }),
    ).toBe(false);
    expect(
      cache.putSkip("long-reason", {
        strategy: "text",
        reason: "r".repeat(129),
        originalTokens: 10,
      }),
    ).toBe(false);
    expect(
      cache.putSkip("raw-reason", {
        strategy: "text",
        reason: "selected raw output line",
        originalTokens: 10,
      }),
    ).toBe(false);
    expect(
      cache.putResult("raw-strategy", {
        ...result("compressed"),
        strategy: "user-secret",
      }),
    ).toBe(false);
    expect(
      cache.putSkip("invalid-skip-tokens", {
        strategy: "text",
        reason: "no_savings",
        originalTokens: { raw: "must not be retained" } as unknown as number,
      }),
    ).toBe(false);
    expect(
      cache.putResult("invalid-result-tokens", {
        ...result("compressed"),
        compressedTokens: 101,
      }),
    ).toBe(false);
    expect(cache.stats).toMatchObject({
      entryCount: 1,
      resultEntryCount: 1,
      skipEntryCount: 0,
    });
  });

  it("updates result-character accounting when a key is replaced", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });

    cache.putResult("same", result("12345"));
    expect(cache.stats.resultChars).toBe(5);

    cache.putResult("same", result("12"));
    expect(cache.stats).toMatchObject({
      entryCount: 1,
      resultEntryCount: 1,
      skipEntryCount: 0,
      resultChars: 2,
    });

    cache.putSkip("same", {
      strategy: "code",
      reason: "insufficient_savings",
      originalTokens: 100,
    });
    expect(cache.stats).toMatchObject({
      entryCount: 1,
      resultEntryCount: 0,
      skipEntryCount: 1,
      resultChars: 0,
    });

    cache.putResult("same", result("123"));
    expect(cache.stats).toMatchObject({
      entryCount: 1,
      resultEntryCount: 1,
      skipEntryCount: 0,
      resultChars: 3,
    });
  });

  it("removes a stale replacement before rejecting an oversized result", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 10,
      maxSingleResultChars: 5,
    });
    cache.putResult("same", result("old"));

    expect(cache.putResult("same", result("123456"))).toBe(false);

    expect(cache.get("same")).toBeUndefined();
    expect(cache.stats.resultChars).toBe(0);
  });

  it("clear removes both decision layers and resets accounting", () => {
    const cache = new CompressionDecisionCache({
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 100,
    });
    cache.putResult("result", result("1234"));
    cache.putSkip("skip", {
      strategy: "table",
      reason: "too_few_lines",
      originalTokens: 3,
    });

    cache.clear();

    expect(cache.get("result")).toBeUndefined();
    expect(cache.get("skip")).toBeUndefined();
    expect(cache.stats).toEqual({
      entryCount: 0,
      resultEntryCount: 0,
      skipEntryCount: 0,
      resultChars: 0,
    });
  });

  it("strictly validates construction limits", () => {
    const valid = {
      maxEntries: 2,
      maxResultChars: 100,
      maxSingleResultChars: 50,
    };

    expect(
      () => new CompressionDecisionCache({ ...valid, maxEntries: 0 }),
    ).toThrow(/maxEntries.*positive safe integer/);
    expect(
      () => new CompressionDecisionCache({ ...valid, maxEntries: 1.5 }),
    ).toThrow(/maxEntries.*positive safe integer/);
    expect(
      () => new CompressionDecisionCache({ ...valid, maxResultChars: 0 }),
    ).toThrow(/maxResultChars.*positive safe integer/);
    expect(
      () =>
        new CompressionDecisionCache({ ...valid, maxSingleResultChars: 0 }),
    ).toThrow(/maxSingleResultChars.*positive safe integer/);
    expect(
      () =>
        new CompressionDecisionCache({
          ...valid,
          maxResultChars: 10,
          maxSingleResultChars: 11,
        }),
    ).toThrow(/maxSingleResultChars.*maxResultChars/);
    expect(
      () => new CompressionDecisionCache({ ...valid, ttlMs: 0 }),
    ).toThrow(/ttlMs.*positive safe integer/);
    expect(
      () => new CompressionDecisionCache({ ...valid, ttlMs: Number.NaN }),
    ).toThrow(/ttlMs.*positive safe integer/);
    expect(
      () =>
        new CompressionDecisionCache({
          ...valid,
          clock: "now" as unknown as () => number,
        }),
    ).toThrow(/clock.*function/);
  });
});

describe("StrategyCircuitBreaker", () => {
  it("isolates consecutive failures by strategy", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 2 });

    breaker.recordFailure("code");
    breaker.recordFailure("log");
    expect(breaker.isOpen("code")).toBe(false);
    expect(breaker.isOpen("log")).toBe(false);

    breaker.recordFailure("code");
    expect(breaker.isOpen("code")).toBe(true);
    expect(breaker.isOpen("log")).toBe(false);
  });

  it("opens only after the default three consecutive failures", () => {
    const breaker = new StrategyCircuitBreaker();

    breaker.recordFailure("json");
    breaker.recordFailure("json");
    expect(breaker.isOpen("json")).toBe(false);

    breaker.recordFailure("json");
    expect(breaker.isOpen("json")).toBe(true);
  });

  it("resets the consecutive-failure count after success", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 2 });

    breaker.recordFailure("table");
    breaker.recordSuccess("table");
    breaker.recordFailure("table");

    expect(breaker.isOpen("table")).toBe(false);
  });

  it("allows a half-open trial after cooldown and reopens on trial failure", () => {
    let now = 5_000;
    const breaker = new StrategyCircuitBreaker({
      failureThreshold: 1,
      clock: () => now,
    });

    breaker.recordFailure("code");
    expect(breaker.isOpen("code")).toBe(true);

    now += 59_999;
    expect(breaker.isOpen("code")).toBe(true);
    now += 1;
    expect(breaker.isOpen("code")).toBe(false);

    breaker.recordFailure("code");
    expect(breaker.isOpen("code")).toBe(true);
    breaker.recordSuccess("code");
    expect(breaker.isOpen("code")).toBe(false);
  });

  it("allows only one half-open trial until it succeeds or fails", () => {
    let now = 5_000;
    const breaker = new StrategyCircuitBreaker({
      failureThreshold: 1,
      clock: () => now,
    });
    breaker.recordFailure("code");

    now += 60_000;
    expect(breaker.isOpen("code")).toBe(false);
    expect(breaker.isOpen("code")).toBe(true);

    breaker.recordSuccess("code");
    expect(breaker.isOpen("code")).toBe(false);
  });

  it("can be disabled with a zero threshold", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 0 });

    for (let index = 0; index < 10; index += 1) {
      breaker.recordFailure("log");
    }

    expect(breaker.isOpen("log")).toBe(false);
  });

  it("clear closes every strategy", () => {
    const breaker = new StrategyCircuitBreaker({ failureThreshold: 1 });
    breaker.recordFailure("code");
    breaker.recordFailure("log");

    breaker.clear();

    expect(breaker.isOpen("code")).toBe(false);
    expect(breaker.isOpen("log")).toBe(false);
  });

  it("strictly validates breaker construction", () => {
    expect(
      () => new StrategyCircuitBreaker({ failureThreshold: -1 }),
    ).toThrow(/failureThreshold.*non-negative safe integer/);
    expect(
      () => new StrategyCircuitBreaker({ failureThreshold: 1.5 }),
    ).toThrow(/failureThreshold.*non-negative safe integer/);
    expect(
      () => new StrategyCircuitBreaker({ cooldownMs: 0 }),
    ).toThrow(/cooldownMs.*positive safe integer/);
    expect(
      () => new StrategyCircuitBreaker({ cooldownMs: Number.NaN }),
    ).toThrow(/cooldownMs.*positive safe integer/);
    expect(
      () =>
        new StrategyCircuitBreaker({
          clock: "now" as unknown as () => number,
        }),
    ).toThrow(/clock.*function/);
  });
});
