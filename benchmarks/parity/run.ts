import { performance } from "node:perf_hooks";

import { NativeHeadroomCompatibleEngine } from "../../src/engine/native.js";
import { MemoryCCRStore } from "../../src/store/memory.js";
import { compareParityResults, type LocalParityResult } from "./compare.js";
import { PARITY_FIXTURES } from "./fixtures.js";
import { loadParityOracle, validateParityOracle } from "./oracle.js";

const oracle = await loadParityOracle();
validateParityOracle(oracle, PARITY_FIXTURES);

const store = new MemoryCCRStore();
const engine = new NativeHeadroomCompatibleEngine(store);
const results: LocalParityResult[] = [];

try {
  for (const fixture of PARITY_FIXTURES) {
    const startedAt = performance.now();
    const result = await engine.compress({
      tool: fixture.tool,
      sessionID: `parity-${fixture.id}`,
      callID: `parity-${fixture.id}`,
      args: { query: fixture.query },
      output: fixture.content,
      ttlMs: 60_000,
    });
    results.push({
      id: fixture.id,
      strategy: result.strategy,
      changed: result.changed,
      output: result.output,
      originalTokens: result.originalTokens,
      outputTokens: result.compressedTokens,
      latencyMs: performance.now() - startedAt,
    });
  }
} finally {
  await store.close();
}

const report = compareParityResults(PARITY_FIXTURES, oracle, results);
for (const result of results) {
  console.log(
    `${result.id}: ${result.strategy}, ${result.originalTokens}->${result.outputTokens} tokens, ${result.latencyMs.toFixed(2)}ms`,
  );
}
console.log(
  `aggregate savings parity: ${(report.savingsParity * 100).toFixed(1)}% (${report.localSavings}/${report.upstreamSavings})`,
);

if (!report.passed) {
  const details = report.failures
    .map(
      (failure) =>
        `- ${failure.fixtureId} [${failure.metric}]: ${failure.detail}`,
    )
    .join("\n");
  throw new Error(`Headroom parity quality gate failed:\n${details}`);
}

console.log("Headroom parity quality gate passed");
