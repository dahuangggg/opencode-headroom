import { formatRetrieveMarker } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

function isRequiredDiffLine(line: string): boolean {
  return (
    line.startsWith("diff --git ") ||
    line.startsWith("diff --cc ") ||
    line.startsWith("diff --combined ") ||
    line.startsWith("index ") ||
    line.startsWith("--- ") ||
    line.startsWith("+++ ") ||
    line.startsWith("@@ ") ||
    (line.startsWith("+") && !line.startsWith("+++")) ||
    (line.startsWith("-") && !line.startsWith("---"))
  );
}

export function compressDiff(input: CompressorInput): CompressorResult {
  const lines = input.content.split(/\r?\n/);
  const hasFileHeader = lines.some((line) => line.startsWith("diff --git "));
  const hasHunk = lines.some((line) => line.startsWith("@@ "));
  if (!hasFileHeader || !hasHunk || lines.length < 20) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "too_few_lines",
    };
  }

  const kept = lines.filter(isRequiredDiffLine);
  const omitted = lines.length - kept.length;
  if (omitted <= 0) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "nothing_dropped",
    };
  }
  const output = [
    ...kept,
    `[${omitted} unchanged context lines omitted]`,
    formatRetrieveMarker(input.hash),
  ].join("\n");
  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "diff",
      reason: "no_savings",
    };
  }
  return {
    changed: true,
    output,
    strategy: "diff",
    debug: {
      compressor: {
        strategy: "diff",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: { structuralAndChangedLines: kept.length },
        dropped: { contextLines: omitted },
      },
    },
  };
}
