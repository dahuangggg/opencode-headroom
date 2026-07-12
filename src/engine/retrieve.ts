import type { CCREntry } from "../store/types.js";
import type { RetrieveMode, RetrieveOptions, RetrieveRequest } from "./types.js";

interface NormalizedRetrieveOptions {
  mode: RetrieveMode;
  query?: string;
  startLine?: number;
  endLine?: number;
  lines: number;
  contextLines: number;
  maxMatches: number;
  maxChars?: number;
}

const DEFAULT_LINES = 80;
const DEFAULT_CONTEXT_LINES = 2;
const DEFAULT_MAX_MATCHES = 20;
const DEFAULT_MAX_CHARS = 12_000;

function clampInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(1, Math.floor(value as number));
}

function normalizeRetrieveRequest(
  request: RetrieveRequest | undefined,
  entryDefaults: CCREntry["retrieveDefaults"],
): NormalizedRetrieveOptions {
  const defaultMode = entryDefaults?.mode ?? "summary";
  const defaultMaxChars =
    entryDefaults?.maxChars === undefined
      ? defaultMode === "full"
        ? undefined
        : DEFAULT_MAX_CHARS
      : clampInteger(entryDefaults.maxChars, DEFAULT_MAX_CHARS);
  if (typeof request === "string") {
    const hasQuery = Boolean(request.trim());
    return {
      mode: hasQuery ? "query" : defaultMode,
      query: request.trim() || undefined,
      lines: DEFAULT_LINES,
      contextLines: DEFAULT_CONTEXT_LINES,
      maxMatches: DEFAULT_MAX_MATCHES,
      maxChars: hasQuery ? DEFAULT_MAX_CHARS : defaultMaxChars,
    };
  }

  const hasRange = request?.startLine !== undefined || request?.endLine !== undefined;
  const hasQuery = Boolean(request?.query?.trim());
  const usesEntryDefault = request?.mode === undefined && !hasRange && !hasQuery;
  const mode =
    request?.mode ??
    (hasRange ? "range" : hasQuery ? "query" : defaultMode);

  return {
    mode,
    query: request?.query?.trim() || undefined,
    startLine: request?.startLine,
    endLine: request?.endLine,
    lines: clampInteger(request?.lines, DEFAULT_LINES),
    contextLines: Math.max(
      0,
      Math.floor(request?.contextLines ?? DEFAULT_CONTEXT_LINES),
    ),
    maxMatches: clampInteger(request?.maxMatches, DEFAULT_MAX_MATCHES),
    maxChars:
      request?.maxChars === undefined
        ? usesEntryDefault
          ? defaultMaxChars
          : mode === "full"
            ? undefined
            : DEFAULT_MAX_CHARS
        : clampInteger(request.maxChars, 1),
  };
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").toLowerCase();
}

function tokenizeQuery(query: string | undefined): string[] {
  const words = normalizeSearchText(query ?? "").match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.filter((word) => /[^\x00-\x7f]/u.test(word) || word.length >= 3);
}

function header(entry: CCREntry, mode: RetrieveMode, detail: string): string[] {
  return [
    "[Headroom retrieve]",
    `hash: ${entry.hash}`,
    `mode: ${mode}`,
    `strategy: ${entry.strategy}`,
    `original tokens: ${entry.originalTokens}`,
    `original chars: ${entry.originalChars}`,
    detail,
    "",
  ];
}

function lineRange(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  const start = Math.max(1, Math.min(startLine, lines.length || 1));
  const end = Math.max(start, Math.min(endLine, lines.length || start));
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n");
}

interface RetrievalView {
  lines: string[];
  source: "original" | "pretty-json";
}

function prettyPrintJson(content: string): string | undefined {
  const compact = content.trim();
  try {
    JSON.parse(compact);
  } catch {
    return undefined;
  }

  let output = "";
  let indent = 0;
  let inString = false;
  let escaped = false;
  const expandedContainers: boolean[] = [];
  const indentation = () => "  ".repeat(indent);
  const nextNonWhitespace = (start: number): string | undefined => {
    for (let index = start; index < compact.length; index += 1) {
      const character = compact[index];
      if (character && !/\s/u.test(character)) {
        return character;
      }
    }
    return undefined;
  };

  for (let index = 0; index < compact.length; index += 1) {
    const character = compact[index]!;
    if (inString) {
      output += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (/\s/u.test(character)) {
      continue;
    }
    if (character === "{" || character === "[") {
      const closing = character === "{" ? "}" : "]";
      const expanded = nextNonWhitespace(index + 1) !== closing;
      expandedContainers.push(expanded);
      output += character;
      if (expanded) {
        indent += 1;
        output += `\n${indentation()}`;
      }
      continue;
    }
    if (character === "}" || character === "]") {
      const expanded = expandedContainers.pop() ?? false;
      if (expanded) {
        indent = Math.max(0, indent - 1);
        output += `\n${indentation()}`;
      }
      output += character;
      continue;
    }
    if (character === ",") {
      output += `,\n${indentation()}`;
      continue;
    }
    if (character === ":") {
      output += ": ";
      continue;
    }
    output += character;
  }

  return output;
}

function retrievalView(entry: CCREntry): RetrievalView {
  const originalLines = entry.originalContent.split(/\r?\n/);
  if (entry.strategy !== "json" || originalLines.length !== 1) {
    return { lines: originalLines, source: "original" };
  }
  const pretty = prettyPrintJson(entry.originalContent);
  if (!pretty) {
    return { lines: originalLines, source: "original" };
  }
  const lines = pretty.split("\n");
  return lines.length > 1
    ? { lines, source: "pretty-json" }
    : { lines: originalLines, source: "original" };
}

function clip(content: string, maxChars: number | undefined): string {
  if (maxChars === undefined || content.length <= maxChars) {
    return content;
  }
  const suffix = `\n[truncated to ${maxChars} chars; use narrower query/range or mode=full]`;
  if (suffix.length >= maxChars) {
    return suffix.trimStart().slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - suffix.length)}${suffix}`;
}

function retrieveSummary(entry: CCREntry): string {
  const view = retrievalView(entry);
  const lines = view.lines;
  const previewLines = [
    ...lineRange(lines, 1, Math.min(5, lines.length)).split("\n"),
    ...(lines.length > 10
      ? ["...", ...lineRange(lines, Math.max(1, lines.length - 4), lines.length).split("\n")]
      : []),
  ];
  return [
    ...header(entry, "summary", `${view.source} lines: ${lines.length}`),
    `tool: ${entry.tool ?? "unknown"}`,
    `callID: ${entry.callID ?? "unknown"}`,
    `compressed tokens: ${entry.compressedTokens}`,
    `retrieval count: ${entry.retrievalCount}`,
    "",
    "Use mode=query with a specific query, mode=range with startLine/endLine, mode=head, mode=tail, or mode=full for exact full original content.",
    "",
    "Preview:",
    ...previewLines,
  ].join("\n");
}

function retrieveQuery(entry: CCREntry, options: NormalizedRetrieveOptions): string {
  const view = retrievalView(entry);
  const lines = view.lines;
  const words = tokenizeQuery(options.query);
  const selected = new Set<number>();
  let matches = 0;

  if (words.length > 0) {
    for (const [index, line] of lines.entries()) {
      const lower = normalizeSearchText(line);
      if (!words.some((word) => lower.includes(word))) {
        continue;
      }
      matches += 1;
      for (
        let cursor = Math.max(0, index - options.contextLines);
        cursor <= Math.min(lines.length - 1, index + options.contextLines);
        cursor += 1
      ) {
        selected.add(cursor);
      }
      if (matches >= options.maxMatches) {
        break;
      }
    }
  }

  if (selected.size === 0) {
    return clip(
      [
        ...header(
          entry,
          "query",
          `query: ${options.query ?? ""} | matches: 0 | ${view.source} lines: ${lines.length}`,
        ),
        "No matching lines found. Try a broader query, mode=head, mode=tail, mode=range, or mode=full.",
      ].join("\n"),
      options.maxChars,
    );
  }

  const body = [...selected]
    .sort((a, b) => a - b)
    .map((index) => `${index + 1}: ${lines[index] ?? ""}`)
    .join("\n");

  return clip(
    [
      ...header(
        entry,
        "query",
        `query: ${options.query ?? ""} | matches: ${matches} | returned lines: ${selected.size} | ${view.source} lines: ${lines.length}`,
      ),
      body,
    ].join("\n"),
    options.maxChars,
  );
}

export function retrieveEntry(
  entry: CCREntry,
  request?: RetrieveRequest,
): string {
  const options = normalizeRetrieveRequest(request, entry.retrieveDefaults);
  if (options.mode === "full") {
    return options.maxChars
      ? clip(entry.originalContent, options.maxChars)
      : entry.originalContent;
  }

  const view = retrievalView(entry);
  const lines = view.lines;
  if (options.mode === "summary") {
    return clip(retrieveSummary(entry), options.maxChars);
  }
  if (options.mode === "query") {
    return retrieveQuery(entry, options);
  }
  if (options.mode === "range") {
    const start = clampInteger(options.startLine, 1);
    const end = clampInteger(options.endLine, start + options.lines - 1);
    const body = lineRange(lines, start, end);
    return clip(
      [
        ...header(
          entry,
          "range",
          `lines: ${start}-${end} | ${view.source} lines: ${lines.length}`,
        ),
        body,
      ].join("\n"),
      options.maxChars,
    );
  }
  if (options.mode === "head") {
    const end = Math.min(options.lines, lines.length);
    return clip(
      [
        ...header(
          entry,
          "head",
          `lines: 1-${end} | ${view.source} lines: ${lines.length}`,
        ),
        lineRange(lines, 1, end),
      ].join("\n"),
      options.maxChars,
    );
  }

  const start = Math.max(1, lines.length - options.lines + 1);
  return clip(
    [
      ...header(
        entry,
        "tail",
        `lines: ${start}-${lines.length} | ${view.source} lines: ${lines.length}`,
      ),
      lineRange(lines, start, lines.length),
    ].join("\n"),
    options.maxChars,
  );
}
