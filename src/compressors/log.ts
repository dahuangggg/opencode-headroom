import { formatRetrieveMarker } from "../markers.js";
import { computeOptimalK } from "../engine/adaptive-sizer.js";
import type { CompressorInput, CompressorResult } from "./types.js";

export type LogLevel =
  | "ERROR"
  | "FAIL"
  | "WARN"
  | "INFO"
  | "DEBUG"
  | "TRACE"
  | "UNKNOWN";
export type LogFormat = "pytest" | "npm" | "cargo" | "make" | "jest" | "generic";

export interface ClassifiedLogLine {
  index: number;
  content: string;
  level: LogLevel;
  stackTrace: boolean;
  summary: boolean;
  score: number;
}

const MIN_LINES_FOR_COMPRESSION = 50;
const MAX_TRACE_SCAN_LINES = 24;

type TraceFlavor = "python" | "js" | "java" | "rust" | "go";

function classifyLevel(content: string): LogLevel {
  if (/\b(?:ERROR|FATAL|CRITICAL)\b|^npm ERR!/i.test(content)) {
    return "ERROR";
  }
  if (/\b(?:FAIL|FAILED)\b/i.test(content)) {
    return "FAIL";
  }
  if (/\b(?:WARN|WARNING)\b|^npm WARN/i.test(content)) {
    return "WARN";
  }
  if (/\bINFO\b|^npm info/i.test(content)) {
    return "INFO";
  }
  if (/\bDEBUG\b/i.test(content)) {
    return "DEBUG";
  }
  if (/\bTRACE\b/i.test(content)) {
    return "TRACE";
  }
  return "UNKNOWN";
}

function isPythonFrame(trimmed: string): boolean {
  return /^File ".+", line \d+/.test(trimmed);
}

function hasLineColumnSuffix(content: string): boolean {
  return /:\d+:\d+/.test(content);
}

function isJsAtFrame(trimmed: string): boolean {
  return trimmed.startsWith("at ") && trimmed.includes("(") && hasLineColumnSuffix(trimmed);
}

function isJavaAtFrame(trimmed: string): boolean {
  if (!trimmed.startsWith("at ") || !trimmed.includes("(")) {
    return false;
  }
  const method = trimmed.slice(3, trimmed.indexOf("("));
  return method.length > 0 && /^[\w.$]+$/.test(method);
}

function isGoFrame(content: string): boolean {
  return /^\s*\d+:\s+0x[0-9a-f]+/i.test(content);
}

function traceFlavorFor(content: string): TraceFlavor | undefined {
  const trimmed = content.trimStart();
  if (trimmed.startsWith("Traceback (most recent call last)") || isPythonFrame(trimmed)) {
    return "python";
  }
  if (isJsAtFrame(trimmed)) {
    return "js";
  }
  if (isJavaAtFrame(trimmed)) {
    return "java";
  }
  if (trimmed.startsWith("--> ") && hasLineColumnSuffix(trimmed)) {
    return "rust";
  }
  if (isGoFrame(content)) {
    return "go";
  }
  return undefined;
}

function terminatesTrace(flavor: TraceFlavor, content: string): boolean {
  const trimmed = content.trimStart();
  switch (flavor) {
    case "python": {
      const indentedOrBlank = content.startsWith(" ") || content.startsWith("\t") || content === "";
      const continuation =
        trimmed.startsWith("Traceback") ||
        trimmed.startsWith("File ") ||
        trimmed.startsWith("During handling") ||
        trimmed.startsWith("The above exception");
      if (indentedOrBlank || continuation) {
        return false;
      }
      return !/^[A-Z]/.test(trimmed);
    }
    case "js":
    case "java":
      return !trimmed.startsWith("at ") && content !== "";
    case "rust":
      return !trimmed.startsWith("--> ") && content !== "";
    case "go":
      return !/^\d/.test(trimmed) && content !== "";
  }
}

function isSummaryLine(content: string): boolean {
  return (
    /^={3,}/.test(content) ||
    /^-{3,}/.test(content) ||
    /^\d+ (?:passed|failed|skipped|error|warning)/.test(content) ||
    /^(?:Tests?|Suites?):?\s+\d+/.test(content) ||
    /^(?:TOTAL|Total|Summary)/.test(content) ||
    /^(?:Build|Compile|Test).*(?:succeeded|failed|complete)/.test(content)
  );
}

function scoreLogLine(line: Omit<ClassifiedLogLine, "score">): number {
  const levelScore =
    line.level === "ERROR" || line.level === "FAIL"
      ? 1
      : line.level === "WARN"
        ? 0.5
        : line.level === "INFO" || line.level === "UNKNOWN"
          ? 0.1
          : line.level === "DEBUG"
            ? 0.05
            : 0.02;
  const stackBoost = line.stackTrace ? 0.3 : 0;
  const summaryBoost = line.summary ? 0.4 : 0;
  return Math.min(1, levelScore + stackBoost + summaryBoost);
}

export function classifyLogLine(content: string, index = 0): ClassifiedLogLine {
  const partial = {
    index,
    content,
    level: classifyLevel(content),
    stackTrace: traceFlavorFor(content) !== undefined,
    summary: isSummaryLine(content),
  };
  return { ...partial, score: scoreLogLine(partial) };
}

export function classifyLogLines(lines: string[]): ClassifiedLogLine[] {
  let active: TraceFlavor | undefined;
  let traceLines = 0;
  return lines.map((content, index) => {
    const partial = {
      index,
      content,
      level: classifyLevel(content),
      stackTrace: false,
      summary: isSummaryLine(content),
    };

    if (active) {
      if (traceLines >= MAX_TRACE_SCAN_LINES || terminatesTrace(active, content)) {
        active = undefined;
        traceLines = 0;
        const newFlavor = traceFlavorFor(content);
        if (newFlavor) {
          active = newFlavor;
          traceLines = 1;
          partial.stackTrace = true;
        }
      } else {
        partial.stackTrace = true;
        traceLines += 1;
      }
    } else {
      const flavor = traceFlavorFor(content);
      if (flavor) {
        active = flavor;
        traceLines = 1;
        partial.stackTrace = true;
      }
    }

    return { ...partial, score: scoreLogLine(partial) };
  });
}

export function detectLogFormat(lines: string[]): LogFormat {
  const sample = lines.slice(0, 100);
  const table: Array<[LogFormat, string[]]> = [
    [
      "pytest",
      [
        "=== FAILURES",
        "=== ERRORS",
        "=== test session",
        "=== short test summary",
        "PASSED [",
        "FAILED [",
        "ERROR [",
        "SKIPPED [",
        "collected ",
      ],
    ],
    ["npm", ["npm ERR!", "npm WARN", "npm info", "npm http"]],
    ["cargo", ["Compiling ", "Finished ", "Running ", "warning: ", "error[E"]],
    ["jest", ["PASS ", "FAIL ", "Test Suites:"]],
    ["make", ["make[", "make:", "gcc ", "g++ ", "clang "]],
  ];

  let best: { format: LogFormat; score: number } | undefined;
  for (const [format, markers] of table) {
    const score = sample.filter((line) =>
      markers.some((marker) => line.includes(marker)),
    ).length;
    if (score > 0 && (!best || score > best.score)) {
      best = { format, score };
    }
  }
  return best?.format ?? "generic";
}

function selectWithFirstLast(
  lines: ClassifiedLogLine[],
  maxCount: number,
): ClassifiedLogLine[] {
  if (lines.length <= maxCount) {
    return lines;
  }
  const selected = new Map<number, ClassifiedLogLine>();
  const first = lines[0];
  const last = lines.at(-1);
  if (first) {
    selected.set(first.index, first);
  }
  if (last) {
    selected.set(last.index, last);
  }
  const remaining = [...lines].sort(
    (a, b) => b.score - a.score || a.index - b.index,
  );
  for (const line of remaining) {
    if (selected.size >= maxCount) {
      break;
    }
    selected.set(line.index, line);
  }
  return [...selected.values()];
}

export function normalizeLogLineForDedupe(content: string): string {
  const match = /[:=]/.exec(content);
  const splitAt = match?.index ?? content.length;
  const prefix = content.slice(0, splitAt);
  const suffix = content
    .slice(splitAt)
    .replace(/\d+/g, "N")
    .replace(/0x[0-9a-f]+/gi, "ADDR")
    .replace(/\/[\w/]+\//g, "/PATH/");
  return `${prefix}${suffix}`;
}

function dedupeSimilar(lines: ClassifiedLogLine[]): ClassifiedLogLine[] {
  const seen = new Set<string>();
  const deduped: ClassifiedLogLine[] = [];
  for (const line of lines) {
    const key = normalizeLogLineForDedupe(line.content);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(line);
    }
  }
  return deduped;
}

function stackTraceGroups(lines: ClassifiedLogLine[]): ClassifiedLogLine[][] {
  const groups: ClassifiedLogLine[][] = [];
  let current: ClassifiedLogLine[] = [];
  for (const line of lines) {
    if (line.stackTrace) {
      current.push(line);
    } else if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }
  return groups;
}

function addLine(target: Map<number, ClassifiedLogLine>, line: ClassifiedLogLine | undefined): void {
  if (line) {
    target.set(line.index, line);
  }
}

function buildStats(lines: ClassifiedLogLine[]): Record<string, number> {
  return {
    errors: lines.filter((line) => line.level === "ERROR").length,
    fails: lines.filter((line) => line.level === "FAIL").length,
    warnings: lines.filter((line) => line.level === "WARN").length,
    info: lines.filter((line) => line.level === "INFO").length,
  };
}

function omittedSummary(omitted: number, stats: Record<string, number>): string | undefined {
  const labels = [
    stats.errors ? `${stats.errors} ERROR` : "",
    stats.fails ? `${stats.fails} FAIL` : "",
    stats.warnings ? `${stats.warnings} WARN` : "",
    stats.info ? `${stats.info} INFO` : "",
  ].filter(Boolean);
  if (omitted <= 0 || labels.length === 0) {
    return undefined;
  }
  return `[${omitted} lines omitted: ${labels.join(", ")}]`;
}

export function compressLog(input: CompressorInput): CompressorResult {
  const profile = input.profile?.log ?? {
    maxErrors: 10,
    maxStackTraces: 3,
    stackTraceMaxLines: 20,
    maxWarnings: 5,
    maxTotalLines: 100,
    contextLines: 3,
  };
  const lines = input.content.split(/\r?\n/);
  if (lines.length < MIN_LINES_FOR_COMPRESSION) {
    return {
      changed: false,
      output: input.content,
      strategy: "log",
      reason: "too_few_lines",
    };
  }

  detectLogFormat(lines);
  const classified = classifyLogLines(lines);
  const required = new Map<number, ClassifiedLogLine>();
  const filler = new Map<number, ClassifiedLogLine>();

  for (const line of selectWithFirstLast(
    classified.filter((line) => line.level === "ERROR"),
    profile.maxErrors,
  )) {
    addLine(required, line);
  }
  for (const line of selectWithFirstLast(
    classified.filter((line) => line.level === "FAIL"),
    profile.maxErrors,
  )) {
    addLine(required, line);
  }
  for (const group of stackTraceGroups(classified).slice(0, profile.maxStackTraces)) {
    for (const line of group.slice(0, profile.stackTraceMaxLines)) {
      addLine(required, line);
    }
  }
  for (const line of classified.filter((line) => line.summary)) {
    addLine(required, line);
  }

  for (const line of dedupeSimilar(
    classified.filter((line) => line.level === "WARN"),
  ).slice(0, profile.maxWarnings)) {
    addLine(filler, line);
  }

  const contextSeed = [...required.values(), ...filler.values()];
  for (const line of contextSeed) {
    for (
      let index = Math.max(0, line.index - profile.contextLines);
      index <= Math.min(classified.length - 1, line.index + profile.contextLines);
      index += 1
    ) {
      if (!required.has(index) && !filler.has(index)) {
        addLine(filler, classified[index]);
      }
    }
  }

  const selected = new Map(required);
  const fillerByScore = [...filler.values()].sort(
    (a, b) => b.score - a.score || a.index - b.index,
  ).filter((line) => !required.has(line.index));
  const availableFillerSlots = Math.max(
    0,
    profile.maxTotalLines - required.size,
  );
  const adaptiveBias = input.profile?.adaptive?.bias ?? 1;
  const adaptive = computeOptimalK(
    fillerByScore.map((line) => normalizeLogLineForDedupe(line.content)),
    {
      bias: adaptiveBias,
      minK: Math.min(10, availableFillerSlots, fillerByScore.length),
      maxK: Math.min(availableFillerSlots, fillerByScore.length),
    },
  );
  for (const line of fillerByScore.slice(0, adaptive.k)) {
    addLine(selected, line);
  }

  const kept = [...selected.values()].sort((a, b) => a.index - b.index);
  const omitted = classified.length - kept.length;
  const selections = kept.slice(0, 50).map((line) => ({
    index: line.index,
    level: line.level,
    reason: required.has(line.index)
      ? line.stackTrace
        ? "stack_trace"
        : line.summary
          ? "summary"
          : line.level === "ERROR" || line.level === "FAIL"
            ? "error_or_fail"
            : "required"
      : "filler",
  }));
  const outputLines = kept.map((line) => line.content);
  const summary = omittedSummary(omitted, buildStats(classified));
  if (summary) {
    outputLines.push(summary);
  }
  outputLines.push(formatRetrieveMarker(input.hash));

  const output = outputLines.join("\n");
  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "log",
      reason: "no_savings",
      debug: {
        compressor: {
          strategy: "log",
          originalChars: input.content.length,
          compressedChars: output.length,
          kept: {
            lines: kept.length,
            requiredLines: required.size,
            fillerLines: Math.max(0, kept.length - required.size),
            adaptive: { ...adaptive, bias: adaptiveBias },
          },
          dropped: {
            lines: omitted,
          },
          selections,
        },
      },
    };
  }
  return {
    changed: true,
    output,
    strategy: "log",
    debug: {
      compressor: {
        strategy: "log",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: {
          lines: kept.length,
          requiredLines: required.size,
          fillerLines: Math.max(0, kept.length - required.size),
          adaptive: { ...adaptive, bias: adaptiveBias },
        },
        dropped: {
          lines: omitted,
        },
        selections,
      },
    },
  };
}
