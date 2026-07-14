import { describe, expect, it } from "vitest";

import { compareParityResults } from "../benchmarks/parity/compare.js";
import { PARITY_FIXTURES } from "../benchmarks/parity/fixtures.js";
import { loadParityOracle } from "../benchmarks/parity/oracle.js";

describe("parity quality comparison", () => {
  it("accepts fact-safe results at the pinned Headroom token budget", async () => {
    const oracle = await loadParityOracle();
    const local = oracle.fixtures.map((baseline, index) => ({
      id: baseline.id,
      strategy: baseline.strategy,
      changed: baseline.outputTokens < baseline.originalTokens,
      output: PARITY_FIXTURES[index]?.content ?? "",
      originalTokens: baseline.originalTokens,
      outputTokens: baseline.outputTokens,
      latencyMs: 1,
    }));

    const report = compareParityResults(PARITY_FIXTURES, oracle, local);

    expect(report.passed).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("names the fixture and metric for every protected-fact regression", async () => {
    const oracle = await loadParityOracle();
    const local = oracle.fixtures.map((baseline, index) => ({
      id: baseline.id,
      strategy: baseline.strategy,
      changed: true,
      output: PARITY_FIXTURES[index]?.content ?? "",
      originalTokens: baseline.originalTokens,
      outputTokens: baseline.outputTokens,
      latencyMs: 1,
    }));
    local[0] = {
      ...local[0]!,
      output: "{}",
      outputTokens: oracle.fixtures[0]!.originalTokens,
    };

    const report = compareParityResults(PARITY_FIXTURES, oracle, local);

    expect(report.passed).toBe(false);
    expect(report.failures).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fixtureId: "json-priority-row",
          metric: "protected_fact",
        }),
        expect.objectContaining({
          fixtureId: "json-priority-row",
          metric: "output_tokens",
        }),
      ]),
    );
  });
});
