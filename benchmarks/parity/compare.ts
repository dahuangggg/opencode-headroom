import type {
  ParityFixture,
  ParityKind,
  ParityOracleSnapshot,
} from "./types.js";

export interface LocalParityResult {
  id: string;
  strategy: string;
  changed: boolean;
  output: string;
  originalTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface ParityFailure {
  fixtureId: string;
  metric: "protected_fact" | "structure" | "output_tokens" | "aggregate_savings";
  detail: string;
}

export interface ParityReport {
  passed: boolean;
  failures: ParityFailure[];
  upstreamSavings: number;
  localSavings: number;
  savingsParity: number;
  medianOutputTokensByKind: Partial<
    Record<ParityKind, { local: number; headroom: number }>
  >;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function structuralFailure(fixture: ParityFixture, output: string): string | undefined {
  if (fixture.kind === "json") {
    try {
      JSON.parse(output);
    } catch {
      return "compressed JSON is not parseable";
    }
  }
  if (fixture.kind === "diff") {
    const lines = output.split("\n");
    const hasFile = lines.some(
      (line) =>
        line.startsWith("diff --git ") ||
        line.startsWith("diff --cc ") ||
        line.startsWith("diff --combined "),
    );
    const hasOldFile = lines.some((line) => line.startsWith("--- "));
    const hasNewFile = lines.some((line) => line.startsWith("+++ "));
    const hasHunk = lines.some((line) => /^@@@?\s/.test(line));
    const hasChange = lines.some(
      (line) =>
        (line.startsWith("+") && !line.startsWith("+++")) ||
        (line.startsWith("-") && !line.startsWith("---")),
    );
    if (!hasFile || !hasOldFile || !hasNewFile || !hasHunk || !hasChange) {
      return "compressed diff is not structurally valid";
    }
  }
  if (fixture.kind === "mixed") {
    for (const marker of ["<stdout>", "</stdout>", "<stderr>", "</stderr>"]) {
      if (!output.includes(marker)) {
        return `mixed output lost framing marker ${marker}`;
      }
    }
  }
  return undefined;
}

function headroomIsFactSafe(
  fixture: ParityFixture,
  baseline: ParityOracleSnapshot["fixtures"][number],
): boolean {
  return (
    baseline.structureValid &&
    fixture.protectedFacts.every((fact) => baseline.retainedFacts.includes(fact))
  );
}

function normalizedLocalOutputTokens(
  baseline: ParityOracleSnapshot["fixtures"][number],
  result: LocalParityResult,
): number {
  if (result.originalTokens <= 0) {
    return baseline.originalTokens;
  }
  return baseline.originalTokens * (result.outputTokens / result.originalTokens);
}

export function compareParityResults(
  fixtures: readonly ParityFixture[],
  oracle: ParityOracleSnapshot,
  local: readonly LocalParityResult[],
): ParityReport {
  const failures: ParityFailure[] = [];
  const localById = new Map(local.map((result) => [result.id, result]));
  const safeRows: Array<{
    fixture: ParityFixture;
    baseline: ParityOracleSnapshot["fixtures"][number];
    result: LocalParityResult;
  }> = [];

  fixtures.forEach((fixture, index) => {
    const baseline = oracle.fixtures[index];
    const result = localById.get(fixture.id);
    if (!baseline || !result) {
      failures.push({
        fixtureId: fixture.id,
        metric: "structure",
        detail: "missing oracle or local result",
      });
      return;
    }

    for (const fact of fixture.protectedFacts) {
      if (!result.output.includes(fact)) {
        failures.push({
          fixtureId: fixture.id,
          metric: "protected_fact",
          detail: `missing ${JSON.stringify(fact)}`,
        });
      }
    }
    const structure = structuralFailure(fixture, result.output);
    if (structure) {
      failures.push({
        fixtureId: fixture.id,
        metric: "structure",
        detail: structure,
      });
    }

    if (
      headroomIsFactSafe(fixture, baseline) &&
      baseline.outputTokens < baseline.originalTokens
    ) {
      safeRows.push({ fixture, baseline, result });
    }
  });

  const medianOutputTokensByKind: ParityReport["medianOutputTokensByKind"] = {};
  const kinds = [...new Set(safeRows.map(({ fixture }) => fixture.kind))];
  for (const kind of kinds) {
    const rows = safeRows.filter(({ fixture }) => fixture.kind === kind);
    const localMedian = median(
      rows.map(({ baseline, result }) =>
        normalizedLocalOutputTokens(baseline, result),
      ),
    );
    const headroomMedian = median(rows.map(({ baseline }) => baseline.outputTokens));
    medianOutputTokensByKind[kind] = {
      local: localMedian,
      headroom: headroomMedian,
    };
    if (localMedian > headroomMedian * 1.1) {
      failures.push({
        fixtureId: rows.map(({ fixture }) => fixture.id).join(","),
        metric: "output_tokens",
        detail: `${kind} median ${localMedian} exceeds Headroom ${headroomMedian} by more than 10%`,
      });
    }
  }

  const upstreamSavings = safeRows.reduce(
    (sum, { baseline }) => sum + baseline.originalTokens - baseline.outputTokens,
    0,
  );
  const localSavings = safeRows.reduce(
    (sum, { baseline, result }) =>
      sum +
      Math.max(
        0,
        baseline.originalTokens - normalizedLocalOutputTokens(baseline, result),
      ),
    0,
  );
  const savingsParity = upstreamSavings === 0 ? 1 : localSavings / upstreamSavings;
  if (savingsParity < 0.95) {
    failures.push({
      fixtureId: "aggregate",
      metric: "aggregate_savings",
      detail: `local savings ${localSavings} are ${(savingsParity * 100).toFixed(1)}% of Headroom savings ${upstreamSavings}`,
    });
  }

  return {
    passed: failures.length === 0,
    failures,
    upstreamSavings,
    localSavings,
    savingsParity,
    medianOutputTokensByKind,
  };
}
