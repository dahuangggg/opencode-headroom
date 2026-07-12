import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { NativeHeadroomCompatibleEngine } from "../src/engine/native.js";
import { MemoryCCRStore } from "../src/store/memory.js";
import { estimateTokens } from "../src/token.js";

interface Fixture {
  name: string;
  kind: string;
  query: string;
  content: string;
}

interface FixtureResult {
  fixture: Fixture;
  originalTokens: number;
  compressedTokens: number;
  strategy: string;
  changed: boolean;
  hash?: string;
  targetedRetrieveTokens: number;
  fullRetrieveTokens: number;
  cappedFullRetrieveTokens: number;
}

interface CostScenario {
  name: string;
  cost: number;
  deltaVsBaseline: number;
  savingsPct: number;
}

const PRICE = {
  uncachedInputPerToken: 3.0 / 1_000_000,
  cacheReadPerToken: 0.3 / 1_000_000,
  cacheWritePerToken: 3.75 / 1_000_000,
};

const FUTURE_CACHE_READ_TURNS = 3;
const OPENCODE_TOOL_OUTPUT_CAP_CHARS = 51_264;
const REPORT_PATH = join(
  process.cwd(),
  "benchmarks",
  "results",
  "headroom-cost-experiment.md",
);

function makeJsonFixture(): string {
  const rows = Array.from({ length: 360 }, (_, index) => ({
    id: index + 1,
    status:
      index % 53 === 0 ? "error" : index % 29 === 0 ? "warning" : "ok",
    code:
      index % 53 === 0
        ? "E_DATA_DRIFT"
        : index % 29 === 0
          ? "W_OUTLIER"
          : "OK",
    message:
      index % 53 === 0
        ? `metric revenue_${index} failed validation near row ${index * 17}`
        : index % 29 === 0
          ? `outlier detected in segment_${index % 8}`
          : `row ${index + 1} processed successfully`,
    file_path: `/warehouse/jobs/daily_metrics/partition_${String(index % 12).padStart(2, "0")}/part-${String(index).padStart(5, "0")}.json`,
    line_number: 1000 + index,
    values: {
      revenue: Number((1000 + index * 3.17).toFixed(2)),
      users: 5000 + index * 7,
      conversion: Number((0.02 + (index % 30) / 1000).toFixed(3)),
    },
  }));
  return JSON.stringify(rows, null, 2);
}

function makeSearchFixture(): string {
  return Array.from({ length: 260 }, (_, index) => {
    const file =
      index % 5 === 0
        ? "src/auth/session.ts"
        : index % 5 === 1
          ? "src/billing/invoices.ts"
          : index % 5 === 2
            ? "src/api/routes.ts"
            : index % 5 === 3
              ? "tests/auth.test.ts"
              : "docs/runbook.md";
    const line = 20 + index * 3;
    const body =
      index % 47 === 0
        ? `ERROR auth token rejected for tenant_${index % 9}`
        : index % 31 === 0
          ? `WARNING retry backoff missing for auth flow ${index}`
          : `auth event ${index} status ok request_id=req_${index}`;
    return `${file}:${line}:${body}`;
  }).join("\n");
}

function makeLogFixture(): string {
  const lines: string[] = [];
  for (let index = 0; index < 620; index += 1) {
    if (index % 137 === 0) {
      lines.push(
        `2026-06-17T10:${String(index % 60).padStart(2, "0")}:22Z FATAL job=daily-kpi file=/srv/nova/pipelines/kpi_job.py line=${220 + index} status=failed message=exception while computing grouped result`,
      );
      lines.push("Traceback (most recent call last):");
      lines.push(
        `  File "/srv/nova/pipelines/kpi_job.py", line ${220 + index}, in run_batch`,
      );
      lines.push("    result = compute_dataframe_metrics(batch)");
      lines.push(
        `ValueError: status field mismatch for cohort_${index % 21}`,
      );
    } else if (index % 41 === 0) {
      lines.push(
        `2026-06-17T10:${String(index % 60).padStart(2, "0")}:58Z ERROR job=daily-kpi file=/srv/nova/pipelines/kpi_job.py line=${200 + index} status=failed message=data drift detected`,
      );
    } else if (index % 17 === 0) {
      lines.push(
        `2026-06-17T10:${String(index % 60).padStart(2, "0")}:11Z WARN job=daily-kpi file=/srv/nova/pipelines/kpi_job.py line=${200 + index} status=retry message=slow query detected`,
      );
    } else {
      lines.push(
        `2026-06-17T10:${String(index % 60).padStart(2, "0")}:00Z INFO job=daily-kpi file=/srv/nova/pipelines/kpi_job.py line=${200 + index} status=ok message=batch ${index} processed`,
      );
    }
  }
  return lines.join("\n");
}

function makeTextFixture(): string {
  return Array.from({ length: 180 }, (_, index) => {
    const issue =
      index % 44 === 0
        ? "The critical issue is status field mismatch and retry backoff."
        : index % 27 === 0
          ? "Warning: auth token rotation must be verified before release."
          : "Routine analysis confirms the cohort trend is stable.";
    return `Paragraph ${index + 1}: ${issue} Preserve file path /data/marts/report_${index + 1}.parquet, line number ${9000 + index}, fields status, code, and message.`;
  }).join("\n\n");
}

function fixtures(): Fixture[] {
  return [
    {
      name: "json_rows",
      kind: "json",
      query: "E_DATA_DRIFT failed validation",
      content: makeJsonFixture(),
    },
    {
      name: "search_results",
      kind: "search",
      query: "auth ERROR token rejected",
      content: makeSearchFixture(),
    },
    {
      name: "pytest_log",
      kind: "log",
      query: "ERROR FATAL traceback status field mismatch",
      content: makeLogFixture(),
    },
    {
      name: "plain_report",
      kind: "text",
      query: "critical status field mismatch retry backoff",
      content: makeTextFixture(),
    },
  ];
}

function money(value: number): string {
  return `$${value.toFixed(6)}`;
}

function pct(value: number): string {
  return `${value.toFixed(1)}%`;
}

function inputCost(tokens: number, price = PRICE.uncachedInputPerToken): number {
  return tokens * price;
}

function cachedReadCost(tokens: number): number {
  return tokens * PRICE.cacheReadPerToken;
}

function liveOutputLifecycleCost(tokens: number): number {
  return inputCost(tokens) + FUTURE_CACHE_READ_TURNS * cachedReadCost(tokens);
}

function scenarioCost(input: {
  compressedTokens: number;
  retrieveTokens: number;
}): number {
  const latestTurn = inputCost(input.compressedTokens);
  const retrieveTurn = input.retrieveTokens > 0 ? inputCost(input.retrieveTokens) : 0;
  const futureHistory = FUTURE_CACHE_READ_TURNS * cachedReadCost(
    input.compressedTokens + input.retrieveTokens,
  );
  return latestTurn + retrieveTurn + futureHistory;
}

function tokenReduction(original: number, compressed: number): number {
  return original > 0 ? (1 - compressed / original) * 100 : 0;
}

function cappedFullRetrieveTokens(content: string): number {
  return estimateTokens(content.slice(0, OPENCODE_TOOL_OUTPUT_CAP_CHARS));
}

async function compressFixtures(): Promise<FixtureResult[]> {
  const engine = new NativeHeadroomCompatibleEngine(new MemoryCCRStore());
  const results: FixtureResult[] = [];

  for (const fixture of fixtures()) {
    const originalTokens = estimateTokens(fixture.content);
    const result = await engine.compress({
      tool: "bash",
      sessionID: "bench-session",
      callID: `call-${fixture.name}`,
      args: { command: `fixture ${fixture.name}`, query: fixture.query },
      output: fixture.content,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    const retrieved = result.hash
      ? await engine.retrieve(result.hash, { mode: "full" })
      : undefined;
    const fullContent = retrieved?.found ? retrieved.output : fixture.content;
    const targeted = result.hash
      ? await engine.retrieve(result.hash, {
          mode: "query",
          query: fixture.query,
          contextLines: 2,
          maxMatches: 20,
        })
      : undefined;

    results.push({
      fixture,
      originalTokens,
      compressedTokens: result.changed ? result.compressedTokens : originalTokens,
      strategy: result.strategy,
      changed: result.changed,
      hash: result.hash,
      targetedRetrieveTokens:
        targeted?.found === true
          ? estimateTokens(targeted.output)
          : estimateTokens(fixture.content),
      fullRetrieveTokens: estimateTokens(fullContent),
      cappedFullRetrieveTokens: cappedFullRetrieveTokens(fullContent),
    });
  }

  return results;
}

function breakEvenRetrieveRate(input: {
  baselineCost: number;
  noRetrieveCost: number;
  retrieveCost: number;
}): number {
  const numerator = input.baselineCost - input.noRetrieveCost;
  const denominator = input.retrieveCost - input.noRetrieveCost;
  if (denominator <= 0) {
    return 1;
  }
  return Math.max(0, Math.min(1, numerator / denominator));
}

function costScenarios(result: FixtureResult): CostScenario[] {
  const baseline = liveOutputLifecycleCost(result.originalTokens);
  const scenarios = [
    {
      name: "headroom_no_retrieve",
      cost: scenarioCost({
        compressedTokens: result.compressedTokens,
        retrieveTokens: 0,
      }),
    },
    {
      name: "explicit_full_retrieve_raw",
      cost: scenarioCost({
        compressedTokens: result.compressedTokens,
        retrieveTokens: result.fullRetrieveTokens,
      }),
    },
    {
      name: "explicit_full_retrieve_opencode_cap",
      cost: scenarioCost({
        compressedTokens: result.compressedTokens,
        retrieveTokens: result.cappedFullRetrieveTokens,
      }),
    },
    {
      name: "candidate_targeted_retrieve",
      cost: scenarioCost({
        compressedTokens: result.compressedTokens,
        retrieveTokens: result.targetedRetrieveTokens,
      }),
    },
  ];

  return scenarios.map((scenario) => ({
    ...scenario,
    deltaVsBaseline: baseline - scenario.cost,
    savingsPct: baseline > 0 ? ((baseline - scenario.cost) / baseline) * 100 : 0,
  }));
}

function renderReport(results: FixtureResult[]): string {
  const lines: string[] = [];
  const now = new Date().toISOString();
  lines.push("# Headroom Cache/Cost Experiment");
  lines.push("");
  lines.push(`Generated: ${now}`);
  lines.push("");
  lines.push("## Assumptions");
  lines.push("");
  lines.push(`- Future cache-read turns per output: ${FUTURE_CACHE_READ_TURNS}`);
  lines.push("- Stable system/tools/history prefix is excluded from deltas because the native plugin only compresses live tool output.");
  lines.push(`- Uncached input price: ${money(PRICE.uncachedInputPerToken * 1_000_000)} / 1M tokens`);
  lines.push(`- Cache read price: ${money(PRICE.cacheReadPerToken * 1_000_000)} / 1M tokens`);
  lines.push(`- Cache write price reference: ${money(PRICE.cacheWritePerToken * 1_000_000)} / 1M tokens`);
  lines.push(`- OpenCode display cap model: first ${OPENCODE_TOOL_OUTPUT_CAP_CHARS} chars of a large retrieve result.`);
  lines.push("");
  lines.push("## Compression Results");
  lines.push("");
  lines.push("| Fixture | Kind | Strategy | Original tokens | Compressed tokens | Saved | Reduction | Hash |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---|");
  for (const result of results) {
    const saved = Math.max(0, result.originalTokens - result.compressedTokens);
    lines.push(
      `| ${result.fixture.name} | ${result.fixture.kind} | ${result.strategy} | ${result.originalTokens} | ${result.compressedTokens} | ${saved} | ${pct(tokenReduction(result.originalTokens, result.compressedTokens))} | ${result.hash ?? "-"} |`,
    );
  }
  lines.push("");
  lines.push("## Cache-Adjusted Cost Scenarios");
  lines.push("");
  lines.push("| Fixture | Scenario | Cost | Delta vs no Headroom | Savings |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const result of results) {
    const scenarios = costScenarios(result);
    for (const scenario of scenarios) {
      lines.push(
        `| ${result.fixture.name} | ${scenario.name} | ${money(scenario.cost)} | ${money(scenario.deltaVsBaseline)} | ${pct(scenario.savingsPct)} |`,
      );
    }
  }
  lines.push("");
  lines.push("## Retrieve Break-Even");
  lines.push("");
  lines.push("| Fixture | Full raw retrieve break-even | OpenCode-capped full retrieve break-even | Targeted retrieve tokens | Full retrieve tokens |");
  lines.push("|---|---:|---:|---:|---:|");
  for (const result of results) {
    const baseline = liveOutputLifecycleCost(result.originalTokens);
    const noRetrieve = scenarioCost({
      compressedTokens: result.compressedTokens,
      retrieveTokens: 0,
    });
    const full = scenarioCost({
      compressedTokens: result.compressedTokens,
      retrieveTokens: result.fullRetrieveTokens,
    });
    const capped = scenarioCost({
      compressedTokens: result.compressedTokens,
      retrieveTokens: result.cappedFullRetrieveTokens,
    });
    lines.push(
      `| ${result.fixture.name} | ${pct(breakEvenRetrieveRate({ baselineCost: baseline, noRetrieveCost: noRetrieve, retrieveCost: full }) * 100)} | ${pct(breakEvenRetrieveRate({ baselineCost: baseline, noRetrieveCost: noRetrieve, retrieveCost: capped }) * 100)} | ${result.targetedRetrieveTokens} | ${result.fullRetrieveTokens} |`,
    );
  }
  lines.push("");
  lines.push("## Interpretation");
  lines.push("");
  lines.push("- The native plugin is cache-safe when it only rewrites the newest tool output: it does not mutate the provider cache hot zone.");
  lines.push("- Full retrieve can erase savings because the original content re-enters the live zone and later becomes cached history.");
  lines.push("- Targeted retrieve is the likely improvement lever: keep CCR reversible, but retrieve only query/range/head/tail slices unless exact full content is explicitly required.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

export async function runCostExperiment(options: {
  writeReport: boolean;
}): Promise<void> {
  const results = await compressFixtures();
  if (options.writeReport) {
    const report = renderReport(results);
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, report, "utf8");
    console.log(report);
    console.error(`Wrote ${REPORT_PATH}`);
    return;
  }

  const originalTokens = results.reduce(
    (total, result) => total + result.originalTokens,
    0,
  );
  const compressedTokens = results.reduce(
    (total, result) => total + result.compressedTokens,
    0,
  );
  console.log(
    `cost check passed without writing a report: ${results.length} fixtures, ` +
      `${originalTokens} original tokens, ${compressedTokens} compressed tokens`,
  );
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const unknown = args.filter(
    (argument) => argument !== "--check" && argument !== "--report",
  );
  if (unknown.length > 0 || (args.includes("--check") && args.includes("--report"))) {
    throw new Error(
      "Usage: bun benchmarks/headroom-cost-experiment.ts [--check|--report]",
    );
  }
  await runCostExperiment({ writeReport: args.includes("--report") });
}
