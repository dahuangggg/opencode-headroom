import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { runCostExperiment } from "./headroom-cost-experiment.js";
import { runQualityGate } from "./quality-gate.js";

const reportPath = join(
  process.cwd(),
  "benchmarks",
  "results",
  "headroom-cost-experiment.md",
);

function reportSnapshot(): Buffer | undefined {
  return existsSync(reportPath) ? readFileSync(reportPath) : undefined;
}

const reportBefore = reportSnapshot();
await runQualityGate();
await runCostExperiment({ writeReport: false });
assert.deepEqual(
  reportSnapshot(),
  reportBefore,
  "bench:check must not rewrite the tracked cost report",
);
