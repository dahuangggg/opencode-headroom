import { describe, expect, it } from "vitest";

import {
  assertP0HookLatency,
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
});
