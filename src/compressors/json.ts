import { formatJsonSentinel } from "../markers.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const PRIORITY_RE =
  /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|auth|secret|password|security)\b/i;
const MAX_ITEMS_AFTER_CRUSH = 13;

function keySignature(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return Object.keys(value as Record<string, unknown>).sort().join("\u0000");
}

function dominantSignature(rows: unknown[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const signature = keySignature(row);
    counts.set(signature, (counts.get(signature) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

function rowHasPriority(row: unknown, query: string): boolean {
  const text = JSON.stringify(row);
  if (PRIORITY_RE.test(text)) {
    return true;
  }
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 2);
  const lower = text.toLowerCase();
  return words.some((word) => lower.includes(word));
}

export function compressJson(input: CompressorInput): CompressorResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.content);
  } catch {
    return {
      changed: false,
      output: input.content,
      strategy: "json",
      reason: "invalid_json",
    };
  }

  if (!Array.isArray(parsed) || parsed.length <= MAX_ITEMS_AFTER_CRUSH) {
    return {
      changed: false,
      output: input.content,
      strategy: "json",
      reason: "not_large_array",
    };
  }

  const dominant = dominantSignature(parsed);
  const required = new Set<number>([0, parsed.length - 1]);
  parsed.forEach((row, index) => {
    if (keySignature(row) !== dominant) {
      required.add(index);
    }
    if (rowHasPriority(row, input.query)) {
      required.add(index);
    }
  });

  const selected = new Set<number>(required);
  for (
    let index = 0;
    index < parsed.length && selected.size < MAX_ITEMS_AFTER_CRUSH;
    index += 1
  ) {
    selected.add(index);
  }

  const keptIndexes = [...selected].sort((a, b) => a - b);
  const keptRows = keptIndexes.map((index) => parsed[index]);
  const dropped = parsed.length - keptRows.length;
  const selections = keptIndexes.slice(0, 50).map((index) => ({
    index,
    reason: required.has(index) ? "required" : "filler",
  }));
  if (dropped <= 0) {
    return {
      changed: false,
      output: input.content,
      strategy: "json",
      reason: "nothing_dropped",
      debug: {
        compressor: {
          strategy: "json",
          originalChars: input.content.length,
          compressedChars: input.content.length,
          kept: { rows: keptRows.length, requiredRows: required.size },
          dropped: { rows: 0 },
          selections,
        },
      },
    };
  }

  const output = JSON.stringify(
    [...keptRows, formatJsonSentinel(input.hash, dropped)],
    null,
    2,
  );
  if (output.length >= input.content.length) {
    return {
      changed: false,
      output: input.content,
      strategy: "json",
      reason: "no_savings",
      debug: {
        compressor: {
          strategy: "json",
          originalChars: input.content.length,
          compressedChars: output.length,
          kept: { rows: keptRows.length, requiredRows: required.size },
          dropped: { rows: dropped },
          selections,
        },
      },
    };
  }

  return {
    changed: true,
    output,
    strategy: "json",
    debug: {
      compressor: {
        strategy: "json",
        originalChars: input.content.length,
        compressedChars: output.length,
        kept: { rows: keptRows.length, requiredRows: required.size },
        dropped: { rows: dropped },
        selections,
      },
    },
  };
}
