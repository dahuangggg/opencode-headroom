import { describe, expect, it } from "vitest";

import {
  assertDecisionCachePerformanceReported,
  assertP0HookLatency,
  assertP0MessageTransformLatency,
  assertTokenizerPerformanceReported,
  type PerformanceResultRow,
} from "../benchmarks/performance.js";

function hookResult(p95: number): PerformanceResultRow {
  return {
    backend: "memory",
    payload: { label: "10KiB", content: "fixture", bytes: 10 * 1024 },
    operation: "plugin.tool.execute.after",
    distribution: { samples: 25, p50: p95 / 2, p95, max: p95 },
  };
}

function messageTransformResult(p95: number): PerformanceResultRow {
  return {
    ...hookResult(p95),
    operation: "plugin.messages.transform",
  };
}

describe("performance release gate", () => {
  it("keeps the P0 memory hook p95 strictly below 50ms", () => {
    expect(() => assertP0HookLatency([hookResult(49.999)])).not.toThrow();
    expect(() => assertP0HookLatency([hookResult(50)])).toThrow(
      /P0.*p95.*50 ms/i,
    );
  });

  it("fails closed when the P0 hook result is missing", () => {
    expect(() => assertP0HookLatency([])).toThrow(/missing P0/i);
  });

  it("keeps the P0 Read lifecycle transform p95 strictly below 50ms", () => {
    expect(() =>
      assertP0MessageTransformLatency([messageTransformResult(49.999)]),
    ).not.toThrow();
    expect(() =>
      assertP0MessageTransformLatency([messageTransformResult(50)]),
    ).toThrow(/Read lifecycle.*p95.*50 ms/i);
    expect(() => assertP0MessageTransformLatency([])).toThrow(
      /missing P0 Read lifecycle/i,
    );
  });

  it("requires separate cold and hot token-counter rows", () => {
    const base = hookResult(10);
    const cold: PerformanceResultRow = {
      ...base,
      backend: "tokenizer",
      operation: "token.counter(cold)",
    };
    const hot: PerformanceResultRow = {
      ...base,
      backend: "tokenizer",
      operation: "token.counter(hot)",
    };

    expect(() => assertTokenizerPerformanceReported([cold, hot])).not.toThrow();
    expect(() => assertTokenizerPerformanceReported([cold])).toThrow(
      /hot token-counter/i,
    );
    expect(() => assertTokenizerPerformanceReported([hot])).toThrow(
      /cold token-counter/i,
    );
  });

  it("requires a hot decision-cache compression row", () => {
    const cacheHit: PerformanceResultRow = {
      ...hookResult(10),
      operation: "engine.compress(cache-hit)",
    };

    expect(() =>
      assertDecisionCachePerformanceReported([cacheHit]),
    ).not.toThrow();
    expect(() => assertDecisionCachePerformanceReported([])).toThrow(
      /decision-cache/i,
    );
  });
});
