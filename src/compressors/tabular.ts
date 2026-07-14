import { formatRetrieveMarker } from "../markers.js";
import { computeOptimalK } from "../engine/adaptive-sizer.js";
import {
  findNumericOutlierIndexes,
  rankInformationItems,
} from "../engine/information-selector.js";
import type { CompressorInput, CompressorResult } from "./types.js";

interface ParsedTable {
  header: string[];
  rows: string[];
  delimiter: "markdown" | "csv" | "tsv";
}

const ABNORMAL_RE =
  /\b(?:error|failed|failure|fatal|critical|exception|warning|invalid|denied|blocked)\b/i;

export function parseTabular(content: string): ParsedTable | undefined {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 8) return undefined;

  if (
    lines[0]?.includes("|") &&
    /^\s*\|?(?:\s*:?-+:?\s*\|)+\s*:?-+:?\s*\|?\s*$/.test(lines[1] ?? "")
  ) {
    return { header: lines.slice(0, 2), rows: lines.slice(2), delimiter: "markdown" };
  }

  for (const [delimiter, name] of [[",", "csv"], ["\t", "tsv"]] as const) {
    const columns = (lines[0]?.split(delimiter).length ?? 0);
    if (
      columns >= 2 &&
      lines.slice(1, Math.min(lines.length, 20)).every(
        (line) => line.split(delimiter).length === columns,
      )
    ) {
      return { header: lines.slice(0, 1), rows: lines.slice(1), delimiter: name };
    }
  }
  return undefined;
}

function words(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .filter((word) => word.length > 2);
}

function numericRecord(row: string, delimiter: ParsedTable["delimiter"]): Record<string, number> {
  const separator = delimiter === "markdown" ? "|" : delimiter === "csv" ? "," : "\t";
  const record: Record<string, number> = {};
  row.split(separator).forEach((cell, index) => {
    const value = cell.trim();
    if (/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      record[String(index)] = Number(value);
    }
  });
  return record;
}

export function compressTabular(input: CompressorInput): CompressorResult {
  const table = parseTabular(input.content);
  if (!table || table.rows.length < 20) {
    return {
      changed: false,
      output: input.content,
      strategy: "table",
      reason: "too_few_lines",
    };
  }

  const queryWords = words(input.query);
  const required = new Set<number>();
  table.rows.forEach((row, index) => {
    const lower = row.toLowerCase();
    if (
      ABNORMAL_RE.test(row) ||
      queryWords.filter((word) => lower.includes(word)).length >= 1
    ) {
      required.add(index);
    }
  });
  [0, 1, table.rows.length - 2, table.rows.length - 1].forEach((index) => {
    if (index >= 0 && index < table.rows.length) required.add(index);
  });
  for (const index of findNumericOutlierIndexes(
    table.rows.map((row) => numericRecord(row, table.delimiter)),
  )) {
    required.add(index);
  }
  const rankedFiller = rankInformationItems(table.rows, required);
  const maxRows = input.profile?.table?.maxRows ?? 12;
  const availableFillerSlots = Math.max(0, maxRows - required.size);
  const adaptiveBias = input.profile?.adaptive?.bias ?? 1;
  const adaptive = computeOptimalK(
    rankedFiller.map((index) => (table.rows[index] ?? "").replace(/\p{N}+/gu, "N")),
    {
      bias: adaptiveBias,
      minK: Math.min(3, availableFillerSlots, rankedFiller.length),
      maxK: Math.min(availableFillerSlots, rankedFiller.length),
    },
  );
  const selected = new Set(required);
  for (const index of rankedFiller.slice(0, adaptive.k)) {
    selected.add(index);
  }

  const keptRows = [...selected]
    .sort((left, right) => left - right)
    .map((index) => table.rows[index])
    .filter((row): row is string => row !== undefined);
  const omitted = table.rows.length - keptRows.length;
  if (omitted <= 0) {
    return {
      changed: false,
      output: input.content,
      strategy: "table",
      reason: "nothing_dropped",
    };
  }
  const output = [
    ...table.header,
    ...keptRows,
    `[${omitted} rows omitted]`,
    formatRetrieveMarker(input.hash),
  ].join("\n");
  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "table",
      reason: "no_savings",
    };
  }
  return {
    changed: true,
    output,
    strategy: "table",
    debug: {
      compressor: {
        strategy: "table",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: {
          headerLines: table.header.length,
          rows: keptRows.length,
          requiredRows: required.size,
          fillerRows: Math.max(0, keptRows.length - required.size),
          adaptive: { ...adaptive, bias: adaptiveBias },
        },
        dropped: { rows: omitted },
      },
    },
  };
}
