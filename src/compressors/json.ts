import { formatJsonSentinel } from "../markers.js";
import {
  computeOptimalK,
  type AdaptiveSizingDecision,
} from "../engine/adaptive-sizer.js";
import { rankInformationItems } from "../engine/information-selector.js";
import type { CompressorInput, CompressorResult } from "./types.js";

const PRIORITY_RE =
  /\b(error|fail|failed|fatal|critical|exception|warn|warning|todo|fixme|hack|auth|secret|password|security)\b/i;
const NESTED_ARRAY_KEYS = ["results", "data", "items"] as const;

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

interface ArraySummary {
  value: unknown[];
  keptRows: number;
  requiredRows: number;
  droppedRows: number;
  adaptive: AdaptiveSizingDecision & { bias: number; path: string };
  selections: Array<Record<string, unknown>>;
}

interface ObjectSummary {
  value: Record<string, unknown>;
  keptFields: number;
  requiredFields: number;
  droppedFields: number;
  selections: Array<Record<string, unknown>>;
}

function summarizeArray(
  rows: unknown[],
  input: Pick<CompressorInput, "hash" | "query" | "profile">,
  path?: string,
): ArraySummary {
  const dominant = dominantSignature(rows);
  const required = new Set<number>([0, rows.length - 1]);
  rows.forEach((row, index) => {
    if (keySignature(row) !== dominant) {
      required.add(index);
    }
    if (rowHasPriority(row, input.query)) {
      required.add(index);
    }
  });

  const serializedRows = rows.map(serializeForInformation);
  const rankedFiller = rankInformationItems(serializedRows, required);
  const maxItems = input.profile?.json.maxItems ?? 13;
  const availableFillerSlots = Math.max(0, maxItems - required.size);
  const adaptiveBias = input.profile?.adaptive?.bias ?? 1;
  const adaptive = computeOptimalK(
    rankedFiller.map((index) => normalizeForSizing(serializedRows[index] ?? "")),
    {
      bias: adaptiveBias,
      minK: Math.min(3, availableFillerSlots, rankedFiller.length),
      maxK: Math.min(availableFillerSlots, rankedFiller.length),
    },
  );
  const selected = new Set<number>(required);
  for (const index of rankedFiller.slice(0, adaptive.k)) {
    selected.add(index);
  }

  const keptIndexes = [...selected].sort((a, b) => a - b);
  const keptRows = keptIndexes.map((index) => rows[index]);
  const droppedRows = rows.length - keptRows.length;
  return {
    value:
      droppedRows > 0
        ? [...keptRows, formatJsonSentinel(input.hash, droppedRows)]
        : keptRows,
    keptRows: keptRows.length,
    requiredRows: required.size,
    droppedRows,
    adaptive: {
      ...adaptive,
      bias: adaptiveBias,
      path: path ?? "$",
    },
    selections: keptIndexes.slice(0, 50).map((index) => ({
      ...(path ? { path } : {}),
      index,
      reason: required.has(index) ? "required" : "filler",
    })),
  };
}

function serializeForInformation(value: unknown): string {
  const serialized = JSON.stringify(value);
  return serialized === undefined ? String(value) : serialized;
}

function normalizeForSizing(value: string): string {
  return value.replace(/\p{N}+/gu, "N");
}

function summarizeObject(
  object: Record<string, unknown>,
  input: Pick<CompressorInput, "hash" | "query" | "profile">,
): ObjectSummary | undefined {
  const entries = Object.entries(object);
  const maxObjectFields = input.profile?.json.maxObjectFields ?? 13;
  if (
    entries.length <= maxObjectFields ||
    Object.prototype.hasOwnProperty.call(object, "_ccr_dropped")
  ) {
    return undefined;
  }

  const required = new Set<number>([0, entries.length - 1]);
  entries.forEach(([key, value], index) => {
    const isStructured = value !== null && typeof value === "object";
    if (isStructured || rowHasPriority({ [key]: value }, input.query)) {
      required.add(index);
    }
  });
  const selected = new Set<number>(required);
  for (
    let index = 0;
    index < entries.length && selected.size < maxObjectFields;
    index += 1
  ) {
    selected.add(index);
  }

  const keptIndexes = [...selected].sort((a, b) => a - b);
  const droppedFields = entries.length - keptIndexes.length;
  if (droppedFields <= 0) {
    return undefined;
  }
  const keptEntries = keptIndexes.map((index) => entries[index]!);
  return {
    value: {
      ...Object.fromEntries(keptEntries),
      _ccr_dropped: `<<ccr:${input.hash} ${droppedFields}_fields_offloaded>>`,
    },
    keptFields: keptEntries.length,
    requiredFields: required.size,
    droppedFields,
    selections: keptIndexes.slice(0, 50).map((index) => ({
      field: entries[index]?.[0],
      reason: required.has(index) ? "required" : "filler",
    })),
  };
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

  let outputValue: unknown;
  let arrayCount = 0;
  let keptRows = 0;
  let requiredRows = 0;
  let droppedRows = 0;
  let keptFields = 0;
  let requiredFields = 0;
  let droppedFields = 0;
  const adaptive: Array<AdaptiveSizingDecision & { bias: number; path: string }> = [];
  const selections: Array<Record<string, unknown>> = [];

  if (Array.isArray(parsed)) {
    if (parsed.length <= (input.profile?.json.maxItems ?? 13)) {
      return {
        changed: false,
        output: input.content,
        strategy: "json",
        reason: "not_large_array",
      };
    }

    const summary = summarizeArray(parsed, input);
    outputValue = summary.value;
    arrayCount = 1;
    keptRows = summary.keptRows;
    requiredRows = summary.requiredRows;
    droppedRows = summary.droppedRows;
    adaptive.push(summary.adaptive);
    selections.push(...summary.selections);
  } else if (parsed && typeof parsed === "object") {
    const object = parsed as Record<string, unknown>;
    const summarizedObject = { ...object };
    for (const key of NESTED_ARRAY_KEYS) {
      const rows = object[key];
      if (
        !Array.isArray(rows) ||
        rows.length <= (input.profile?.json.maxItems ?? 13)
      ) {
        continue;
      }
      const summary = summarizeArray(rows, input, key);
      summarizedObject[key] = summary.value;
      arrayCount += 1;
      keptRows += summary.keptRows;
      requiredRows += summary.requiredRows;
      droppedRows += summary.droppedRows;
      adaptive.push(summary.adaptive);
      if (selections.length < 50) {
        selections.push(...summary.selections.slice(0, 50 - selections.length));
      }
    }
    outputValue = summarizedObject;

    if (arrayCount === 0) {
      const summary = summarizeObject(object, input);
      if (summary) {
        outputValue = summary.value;
        keptFields = summary.keptFields;
        requiredFields = summary.requiredFields;
        droppedFields = summary.droppedFields;
        selections.push(...summary.selections);
      }
    }
  }

  if (arrayCount === 0 && droppedFields === 0) {
    return {
      changed: false,
      output: input.content,
      strategy: "json",
      reason: "not_large_array",
    };
  }

  if (droppedRows <= 0 && droppedFields <= 0) {
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
          kept: {
            rows: keptRows,
            requiredRows,
            arrays: arrayCount,
            fields: keptFields,
            requiredFields,
            adaptive,
          },
          dropped: { rows: 0, arrays: 0, fields: 0 },
          selections,
        },
      },
    };
  }

  const output = JSON.stringify(outputValue, null, 2);
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
          kept: {
            rows: keptRows,
            requiredRows,
            arrays: arrayCount,
            fields: keptFields,
            requiredFields,
            adaptive,
          },
          dropped: {
            rows: droppedRows,
            arrays: arrayCount,
            fields: droppedFields,
          },
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
        kept: {
          rows: keptRows,
          requiredRows,
          arrays: arrayCount,
          fields: keptFields,
          requiredFields,
          adaptive,
        },
        dropped: {
          rows: droppedRows,
          arrays: arrayCount,
          fields: droppedFields,
        },
        selections,
      },
    },
  };
}
