import type { ContentKind } from "../compressors/types.js";

export type LosslessTransform = "runs" | "search_heading" | "json_table";

export type LosslessCompaction =
  | { changed: false; output: string }
  | { changed: true; output: string; transform: LosslessTransform };

const RUN_MARKER_RE = /^\.\.\. \(repeated (\d+) times\)$/;
const MAX_RUN_EXPANSION = 250_000;
const GREP_ROW_RE = /^(?<path>[^\n:]+):(?<line>\d+):(?<content>.*)$/;
const HEADING_ROW_RE = /^(?<line>\d+):(?<content>.*)$/;
const JSON_TABLE_HEADER_RE = /^\[(?<count>\d+)\](?<keys>\[[^\n]*\])$/;
const JSON_TABLE_MIN_SAVINGS = 0.3;

function splitKeepTrailing(text: string): {
  lines: string[];
  trailingNewline: boolean;
} {
  if (!text) {
    return { lines: [], trailingNewline: false };
  }
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean): string {
  const output = lines.join("\n");
  return trailingNewline ? `${output}\n` : output;
}

export function collapseRuns(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    let end = index + 1;
    while (end < lines.length && lines[end] === lines[index]) {
      end += 1;
    }
    const count = end - index;
    output.push(lines[index] ?? "");
    if (count >= 2) {
      output.push(`... (repeated ${count} times)`);
    }
    index = end;
  }
  return joinLines(output, trailingNewline);
}

export function expandRuns(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const marker = lines[index + 1];
    const match = marker === undefined ? undefined : RUN_MARKER_RE.exec(marker);
    if (match) {
      const count = Number(match[1]);
      if (
        Number.isSafeInteger(count) &&
        count >= 2 &&
        count <= MAX_RUN_EXPANSION
      ) {
        for (let occurrence = 0; occurrence < count; occurrence += 1) {
          output.push(line);
        }
        index += 2;
        continue;
      }
    }
    output.push(line);
    index += 1;
  }
  return joinLines(output, trailingNewline);
}

export function searchHeading(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let currentPath: string | undefined;
  for (const line of lines) {
    const match = GREP_ROW_RE.exec(line);
    const path = match?.groups?.path;
    const lineNumber = match?.groups?.line;
    const content = match?.groups?.content;
    if (path && lineNumber && content !== undefined) {
      if (path !== currentPath) {
        output.push(path);
        currentPath = path;
      }
      output.push(`${lineNumber}:${content}`);
      continue;
    }
    output.push(line);
    currentPath = undefined;
  }
  return joinLines(output, trailingNewline);
}

export function searchUnheading(text: string): string {
  const { lines, trailingNewline } = splitKeepTrailing(text);
  if (lines.length === 0) {
    return text;
  }

  const output: string[] = [];
  let currentPath: string | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    const data = HEADING_ROW_RE.exec(line);
    const lineNumber = data?.groups?.line;
    const content = data?.groups?.content;
    if (currentPath && lineNumber && content !== undefined) {
      output.push(`${currentPath}:${lineNumber}:${content}`);
      index += 1;
      continue;
    }
    if (!data && HEADING_ROW_RE.test(lines[index + 1] ?? "")) {
      currentPath = line;
      index += 1;
      continue;
    }
    currentPath = undefined;
    output.push(line);
    index += 1;
  }
  return joinLines(output, trailingNewline);
}

export function compactJsonTable(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (!Array.isArray(parsed) || parsed.length < 2) {
    return text;
  }

  const first = parsed[0];
  if (!isScalarRecord(first)) {
    return text;
  }
  const keys = Object.keys(first);
  if (keys.length < 2) {
    return text;
  }

  const rows: string[] = [];
  for (const value of parsed) {
    if (
      !isScalarRecord(value)
      || Object.keys(value).length !== keys.length
      || !keys.every((key, index) => Object.keys(value)[index] === key)
    ) {
      return text;
    }
    rows.push(keys.map((key) => JSON.stringify(value[key])).join(","));
  }

  return [`[${parsed.length}]${JSON.stringify(keys)}`, ...rows].join("\n");
}

export function expandJsonTable(text: string): string {
  const lines = text.split("\n");
  const header = JSON_TABLE_HEADER_RE.exec(lines[0] ?? "");
  const expectedCount = Number(header?.groups?.count);
  if (!header?.groups?.keys || !Number.isSafeInteger(expectedCount)) {
    return text;
  }

  try {
    const keys = JSON.parse(header.groups.keys) as unknown;
    if (
      !Array.isArray(keys)
      || keys.length < 2
      || !keys.every((key) => typeof key === "string")
      || new Set(keys).size !== keys.length
      || lines.length - 1 !== expectedCount
    ) {
      return text;
    }
    const records = lines.slice(1).map((line) => {
      const values = JSON.parse(`[${line}]`) as unknown;
      if (!Array.isArray(values) || values.length !== keys.length) {
        throw new Error("invalid compact JSON table row");
      }
      return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
    });
    return JSON.stringify(records);
  } catch {
    return text;
  }
}

function isScalarRecord(value: unknown): value is Record<string, string | number | boolean | null> {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every(
      (field) =>
        field === null
        || typeof field === "string"
        || typeof field === "number"
        || typeof field === "boolean",
    ),
  );
}

export function compactLossless(
  content: string,
  kind: ContentKind,
): LosslessCompaction {
  if (!content) {
    return { changed: false, output: content };
  }

  try {
    if (kind === "json") {
      const output = compactJsonTable(content);
      const expanded = expandJsonTable(output);
      const canonical = JSON.stringify(JSON.parse(content) as unknown);
      const savings = content.length === 0 ? 0 : 1 - output.length / content.length;
      if (
        output !== content
        && savings >= JSON_TABLE_MIN_SAVINGS
        && expanded === canonical
      ) {
        return { changed: true, output, transform: "json_table" };
      }
    }
    if (kind === "search") {
      const output = searchHeading(content);
      if (output.length < content.length && searchUnheading(output) === content) {
        return { changed: true, output, transform: "search_heading" };
      }
    }
    if (kind === "log" || kind === "text") {
      const output = collapseRuns(content);
      if (output.length < content.length && expandRuns(output) === content) {
        return { changed: true, output, transform: "runs" };
      }
    }
  } catch {
    return { changed: false, output: content };
  }
  return { changed: false, output: content };
}
